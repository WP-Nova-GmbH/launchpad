import { makeThreadDeletionStore } from "./ThreadDeletionStore.ts";
import * as Option from "effect/Option";
import { ManagedEndpointProvider } from "../environments/ManagedEndpointProvider.ts";
import { threadVmEndpointOwner } from "./threadVmEndpointOwner.ts";
import { makeThreadDeletionWorker } from "./ThreadDeletionWorker.ts";
import { makeThreadVmResetCancellationWorker } from "./ThreadVmResetCancellationWorker.ts";
import {
  makeE2BThreadVmRestoreCleanup,
  makeE2BThreadVmRestoreImport,
} from "../machines/E2BThreadVmRestoreImport.ts";
import { makeThreadVmResetImportWorker } from "./ThreadVmResetImportWorker.ts";
import { makeThreadVmRestoreImportWorker } from "./ThreadVmRestoreImportWorker.ts";
import { makeThreadVmRestoreServingWorker } from "./ThreadVmRestoreServingWorker.ts";
import { makeThreadVmReplacementCoordinator } from "./ThreadVmReplacementCoordinator.ts";
import { makeThreadVmIdleDeletionWorker } from "./ThreadVmIdleDeletionWorker.ts";
import { makeThreadVmMoveServerWorker } from "./ThreadVmMoveServerWorker.ts";
import { makeE2BThreadVmServer } from "../machines/E2BThreadVmServer.ts";
import { makeThreadVmMoveCleanupWorker } from "./ThreadVmMoveCleanupWorker.ts";
import { Template } from "e2b";
import { parse as parseDomain } from "tldts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { RelayConfiguration } from "../Config.ts";
import { RelayDb } from "../db.ts";
import {
  makeE2BThreadVmCompute,
  type E2BThreadVmSettings,
} from "../machines/E2BThreadVmCompute.ts";
import { makeE2BThreadVmEnrollment } from "../machines/E2BThreadVmEnrollment.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import { makeThreadVmRestoreWorker } from "./ThreadVmRestoreWorker.ts";
import { makeThreadVmBackupRecoveryWorker } from "./ThreadVmBackupRecoveryWorker.ts";
import { makeThreadVmProvisionWorker } from "./ThreadVmProvisionWorker.ts";
import { makeThreadVmEnrollmentWorker } from "./ThreadVmEnrollmentWorker.ts";
import { makeE2BThreadVmActivity } from "../machines/E2BThreadVmActivity.ts";
import { makeThreadVmActivityWorker } from "./ThreadVmActivityWorker.ts";
import { makeE2BThreadVmPause } from "../machines/E2BThreadVmPause.ts";
import { makeThreadVmPauseWorker } from "./ThreadVmPauseWorker.ts";
import { makeThreadVmResumeWorker } from "./ThreadVmResumeWorker.ts";
import { makeE2BThreadVmLease } from "../machines/E2BThreadVmLease.ts";
import { makeThreadVmLeaseWorker } from "./ThreadVmLeaseWorker.ts";
import { makeThreadVmFinalSaveAbortWorker } from "./ThreadVmFinalSaveAbortWorker.ts";
import { makeThreadVmFinalSaveWorker } from "./ThreadVmFinalSaveWorker.ts";
import { makeThreadVmFinalSaveDeletionWorker } from "./ThreadVmFinalSaveDeletionWorker.ts";
import { makeThreadVmBackupWorker } from "./ThreadVmBackupWorker.ts";
import { makeThreadVmBackupRetentionWorker } from "./ThreadVmBackupRetentionWorker.ts";
import { makeThreadVmSavedDiskWorker } from "./ThreadVmSavedDiskWorker.ts";
import { makeThreadVmCancelledSetupCleanupWorker } from "./ThreadVmCancelledSetupCleanupWorker.ts";
import { ThreadArtifactObjectStorage } from "./ThreadArtifactObjects.ts";
import { makeThreadArtifactTransfer } from "./ThreadArtifactTransfer.ts";

export class ThreadVmRuntimeConfigurationError extends Schema.TaggedError<ThreadVmRuntimeConfigurationError>()(
  "ThreadVmRuntimeConfigurationError",
  { message: Schema.String },
) {}
export interface ThreadVmRuntimeSettings {
  readonly compute: E2BThreadVmSettings;
  readonly templateBuildId: string;
  readonly hostId: string;
  readonly maxRunningVms: number;
  readonly publicRelayUrl: string;
  readonly autoPauseEnabled: boolean;
  readonly autoBackupEnabled: boolean;
  readonly autoDeleteEnabled: boolean;
  readonly replacementEnabled: boolean;
  readonly restoreEnabled: boolean;
  readonly resetEnabled: boolean;
  readonly permanentDeleteEnabled?: boolean;
  readonly previewBaseUrl?: string;
}

export class ThreadVmRuntimeConfiguration extends Context.Service<
  ThreadVmRuntimeConfiguration,
  {
    readonly settings: ThreadVmRuntimeSettings | undefined;
  }
>()("launchpad-relay/threads/ThreadVmRuntime/ThreadVmRuntimeConfiguration") {}

/** Cookie isolation follows the public suffix list, including hosted application domains. */
function cookieDomain(origin: string) {
  try {
    const url = new URL(origin);
    const domain = parseDomain(url.hostname, { allowPrivateDomains: true });
    const local = domain.hostname === "localhost" || domain.hostname?.endsWith(".localhost");
    const loopback = domain.hostname === "127.0.0.1" || domain.hostname === "::1";
    if (
      !(url.protocol === "https:" || ((local || loopback) && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return null;
    // Local previews must not share the localhost namespace with an authenticated app.
    if (local) return "localhost";
    if (domain.isIp) return domain.hostname;
    return domain.isIcann || domain.isPrivate ? domain.domain : null;
  } catch {
    return null;
  }
}

/** Disabled relays need no compute configuration and perform no E2B requests. */
export const loadThreadVmRuntimeSettings = Effect.gen(function* () {
  const enabled = yield* Config.Boolean("RELAY_THREAD_VM_PROVISIONING_ENABLED").pipe(
    Config.withDefault(false),
  );
  if (!enabled) return undefined;
  const apiUrl = yield* Config.String("E2B_API_URL");
  const sandboxUrl = yield* Config.String("E2B_SANDBOX_URL");
  const apiKey = yield* Config.Redacted("E2B_API_KEY");
  const templateId = yield* Config.String("E2B_TEMPLATE_REF");
  const templateBuildId = yield* Config.String("E2B_TEMPLATE_BUILD_ID");
  const hostId = yield* Config.String("E2B_HOST_ID");
  const maxRunningVms = yield* Config.Number("E2B_MAX_RUNNING_VMS");
  const publicRelayUrl = yield* Config.String("E2B_PUBLIC_RELAY_URL");
  // Keep automatic pause opt-in until explicit wake admission is connected end-to-end.
  const autoPauseEnabled = yield* Config.Boolean("RELAY_THREAD_VM_AUTO_PAUSE_ENABLED").pipe(
    Config.withDefault(false),
  );
  // Keep automatic captures off until snapshot retention and physical GC are verified.
  const autoBackupEnabled = yield* Config.Boolean("RELAY_THREAD_VM_AUTO_BACKUP_ENABLED").pipe(
    Config.withDefault(false),
  );
  const autoDeleteEnabled = yield* Config.Boolean("RELAY_THREAD_VM_AUTO_DELETE_ENABLED").pipe(
    Config.withDefault(false),
  );
  const replacementEnabled = yield* Config.Boolean("RELAY_THREAD_VM_REPLACEMENT_ENABLED").pipe(
    Config.withDefault(false),
  );
  const permanentDeleteEnabled = yield* Config.Boolean(
    "RELAY_THREAD_VM_PERMANENT_DELETE_ENABLED",
  ).pipe(Config.withDefault(false));
  const resetEnabled = yield* Config.Boolean("RELAY_THREAD_VM_RESET_ENABLED").pipe(
    Config.withDefault(false),
  );
  const restoreEnabled = yield* Config.Boolean("RELAY_THREAD_VM_RESTORE_ENABLED").pipe(
    Config.withDefault(false),
  );
  if (replacementEnabled && !autoBackupEnabled)
    return yield* new ThreadVmRuntimeConfigurationError({
      message: "VM replacement requires verified backups to be enabled.",
    });
  if (autoDeleteEnabled && !autoBackupEnabled)
    return yield* new ThreadVmRuntimeConfigurationError({
      message: "Automatic VM deletion requires verified backups to be enabled.",
    });
  const hostAddresses = (yield* Config.String("E2B_HOST_ADDRESSES"))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const validUrl = (value: string, publicOnly: boolean) => {
    try {
      const url = new URL(value);
      return (
        (publicOnly ? url.protocol === "https:" : ["https:", "http:"].includes(url.protocol)) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (!publicOnly || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      );
    } catch {
      return false;
    }
  };
  if (
    !validUrl(apiUrl, false) ||
    !validUrl(sandboxUrl, false) ||
    !validUrl(publicRelayUrl, true) ||
    !hostId.trim() ||
    Array.from(hostId).length > 191 ||
    !templateBuildId.trim() ||
    !/^[^:]+:build-[^:]+$/u.test(templateId) ||
    !Number.isSafeInteger(maxRunningVms) ||
    maxRunningVms < 1 ||
    !hostAddresses.length ||
    !Redacted.value(apiKey).trim()
  ) {
    return yield* new ThreadVmRuntimeConfigurationError({
      message:
        "Thread VM provisioning requires explicit host capacity, host addresses, an immutable runner build and a public HTTPS relay URL.",
    });
  }
  const previewBaseUrl = yield* Config.String("RELAY_THREAD_VM_PREVIEW_BASE_URL").pipe(
    Config.withDefault(""),
  );
  if (previewBaseUrl) {
    if (!validUrl(previewBaseUrl, false))
      return yield* new ThreadVmRuntimeConfigurationError({
        message: "VM previews require a separate application origin.",
      });
    const preview = new URL(previewBaseUrl),
      relay = new URL(publicRelayUrl);
    // The relay has no client-origin allowlist. Require both browser application
    // and authentication origins rather than guessing their cookie boundaries.
    const appOrigins = (yield* Config.String("RELAY_THREAD_VM_APP_ORIGINS").pipe(
      Config.withDefault(""),
    ))
      .split(",")
      .map((origin) => origin.trim());
    const authOrigins = (yield* Config.String("RELAY_THREAD_VM_AUTH_ORIGINS").pipe(
      Config.withDefault(""),
    ))
      .split(",")
      .map((origin) => origin.trim());
    const protectedDomains = [publicRelayUrl, ...appOrigins, ...authOrigins].map(cookieDomain);
    const previewDomain = cookieDomain(previewBaseUrl);
    const local = preview.hostname === "localhost" || preview.hostname.endsWith(".localhost");
    if (
      !(preview.protocol === "https:" || (local && preview.protocol === "http:")) ||
      preview.username ||
      preview.password ||
      preview.search ||
      preview.hash ||
      preview.pathname !== "/" ||
      !previewDomain ||
      parseDomain(preview.hostname).isIp ||
      protectedDomains.some((domain) => domain === null || domain === previewDomain) ||
      preview.hostname === relay.hostname ||
      relay.hostname.endsWith(`.${preview.hostname}`) ||
      preview.hostname.endsWith(`.${relay.hostname}`)
    )
      return yield* new ThreadVmRuntimeConfigurationError({
        message:
          "VM previews require a separate registrable domain and explicit Launchpad and Clerk origins.",
      });
  }
  return {
    ...(previewBaseUrl ? { previewBaseUrl: new URL(previewBaseUrl).origin } : {}),
    compute: { apiUrl, sandboxUrl, apiKey, templateId, hostAddresses, timeoutMs: 600_000 },
    templateBuildId,
    hostId,
    maxRunningVms,
    publicRelayUrl: publicRelayUrl.replace(/\/$/u, ""),
    autoPauseEnabled,
    autoBackupEnabled,
    autoDeleteEnabled,
    replacementEnabled,
    restoreEnabled,
    resetEnabled,
    permanentDeleteEnabled,
  } satisfies ThreadVmRuntimeSettings;
}).pipe(
  Effect.mapError((error) =>
    error._tag === "ThreadVmRuntimeConfigurationError"
      ? new Config.ConfigError(new ConfigProvider.SourceError({ message: error.message }))
      : error,
  ),
);

/** A bounded sweep over durable claims; interruption never releases uncertain allocations. */
export const reconcileThreadVmProvisioning = Effect.fn("relay.thread_vm.reconcile")(function* (
  settings: ThreadVmRuntimeSettings | undefined,
) {
  if (!settings) return;
  const sql = (yield* RelayDb).$client;
  yield* makeThreadVmCapacityStore(sql).configure(settings.hostId, settings.maxRunningVms);
  const compute = makeE2BThreadVmCompute(settings.compute);
  if (settings.permanentDeleteEnabled)
    yield* makeThreadDeletionStore(sql).admitMirrored(
      settings.hostId,
      compute.restore.requireExecutionRetention(),
    );
  const deleting =
    yield* sql`SELECT 1 FROM relay_thread_deletions WHERE host_id=${settings.hostId} AND phase!='completed' AND retry_at<=clock_timestamp() LIMIT 1`;
  if (deleting.length)
    yield* makeThreadDeletionWorker(
      sql,
      yield* ThreadArtifactObjectStorage,
      compute,
      settings.hostId,
      (allocationId, environmentId) =>
        Effect.serviceOption(ManagedEndpointProvider).pipe(
          Effect.flatMap((provider) =>
            Option.isSome(provider)
              ? provider.value.deprovision({
                  userId: threadVmEndpointOwner(allocationId),
                  environmentId,
                })
              : Effect.succeed(false),
          ),
        ),
    ).runOne();

  yield* makeThreadVmCancelledSetupCleanupWorker(sql, compute, settings.hostId).runOne();
  const cancelledReset =
    yield* sql`SELECT 1 FROM relay_thread_vm_resets WHERE host_id=${settings.hostId} AND phase='cancelling' AND retry_at<=clock_timestamp() LIMIT 1`;
  if (cancelledReset.length)
    yield* makeThreadVmResetCancellationWorker(
      sql,
      yield* ThreadArtifactObjectStorage,
      compute,
      settings.hostId,
    ).runOne();
  yield* makeThreadVmMoveCleanupWorker(sql, compute, settings.hostId).runOne();
  if (settings.restoreEnabled) {
    const recovery =
      yield* sql`SELECT 1 FROM relay_thread_vm_backup_recoveries WHERE host_id=${settings.hostId} AND phase IN ('pending','retaining','retained','stopped') AND retry_at<=clock_timestamp() LIMIT 1`;
    if (recovery.length)
      yield* makeThreadVmBackupRecoveryWorker(
        sql,
        yield* ThreadArtifactObjectStorage,
        compute.restore,
        settings.hostId,
      ).runOne();
  }
  const restoring = yield* sql`SELECT 1 FROM relay_thread_vm_restores
    WHERE host_id=${settings.hostId} AND phase IN ('pending','preparing','prepared','aborting')
      AND retry_at<=clock_timestamp() LIMIT 1`;
  if (restoring.length) {
    const objects = yield* ThreadArtifactObjectStorage;
    yield* makeThreadVmRestoreWorker(sql, objects, compute.restore, settings.hostId).runOne();
  }
  if (settings.restoreEnabled) {
    const objects = yield* ThreadArtifactObjectStorage;
    yield* makeThreadVmRestoreServingWorker(
      sql,
      objects,
      compute.restore,
      settings.hostId,
    ).runOne();
    yield* makeThreadVmRestoreImportWorker(
      sql,
      objects,
      makeE2BThreadVmRestoreImport(settings.compute),
      makeE2BThreadVmServer(settings.compute),
      settings.hostId,
      makeE2BThreadVmRestoreCleanup(settings.compute),
    ).runOne();
  }
  if (settings.resetEnabled)
    yield* makeThreadVmResetImportWorker(
      sql,
      yield* ThreadArtifactObjectStorage,
      makeE2BThreadVmRestoreImport(settings.compute),
      makeE2BThreadVmServer(settings.compute),
      settings.hostId,
    ).runOne();
  const pending = yield* sql`SELECT p.allocation_id FROM relay_thread_vm_provisions p
    JOIN relay_thread_vm_allocations a USING (allocation_id)
    JOIN relay_thread_vm_capacity c ON c.operation_id = p.operation_id
    LEFT JOIN relay_thread_vm_enrollments e ON e.allocation_id = p.allocation_id
    LEFT JOIN relay_thread_vm_setups s ON s.allocation_id = p.allocation_id
    LEFT JOIN relay_thread_placements t ON t.thread_id = a.thread_id
    LEFT JOIN relay_thread_vm_move_destinations d ON d.allocation_id=p.allocation_id
    LEFT JOIN relay_thread_moves m ON m.operation_id=d.operation_id
    WHERE c.host_id = ${settings.hostId} AND p.retry_at <= clock_timestamp()
      AND (p.claim_until IS NULL OR p.claim_until <= clock_timestamp())
      AND (p.phase = 'creating' OR (p.phase = 'created' AND a.state = 'running' AND (e.installed_at IS NULL OR (d.operation_id IS NOT NULL AND m.phase IN ('frozen','ready','committed','completed') AND t.generation IN (p.generation-1,p.generation)) OR s.phase IN ('pending','running') OR (s.phase = 'ready' AND t.environment_id = s.environment_id AND t.generation = p.generation AND t.operation_id IS NULL)))
        OR (p.phase = 'pending' AND (a.state = 'deleting' OR c.state = 'reserved'
          OR (c.state = 'waiting' AND (SELECT count(*) FROM relay_thread_vm_capacity used
            WHERE used.host_id = c.host_id AND used.state IN ('reserved', 'started')) < ${settings.maxRunningVms}))))
    LIMIT 1`;
  if (!pending.length) return;
  const relay = yield* RelayConfiguration;
  const capabilities = yield* compute.restore.capabilities();
  if (!capabilities.renewableLifetime)
    return yield* new ThreadVmRuntimeConfigurationError({
      message: "The compute team does not permit renewable VM lifetime.",
    });
  if (capabilities.durableCreationIdentity !== true)
    return yield* new ThreadVmRuntimeConfigurationError({
      message: "The compute runtime cannot safely recover failed VM creation.",
    });
  const separator = settings.compute.templateId.indexOf(":");
  const templateId = settings.compute.templateId.slice(0, separator);
  const tag = settings.compute.templateId.slice(separator + 1);
  const tags = yield* Effect.tryPromise({
    try: (signal) =>
      Template.getTags(templateId, {
        apiUrl: settings.compute.apiUrl,
        apiKey: Redacted.value(settings.compute.apiKey),
        requestTimeoutMs: 30_000,
        signal,
      }),
    catch: () =>
      new ThreadVmRuntimeConfigurationError({
        message: "Runner build verification is unavailable.",
      }),
  });
  if (!tags.some((entry) => entry.tag === tag && entry.buildId === settings.templateBuildId))
    return yield* new ThreadVmRuntimeConfigurationError({
      message: "Runner template no longer resolves to the verified build.",
    });
  const provision = makeThreadVmProvisionWorker(
    sql,
    compute,
    settings.compute.templateId,
    settings.hostId,
  );
  const enrollment = makeThreadVmEnrollmentWorker(
    sql,
    makeE2BThreadVmEnrollment(settings.compute),
    { url: settings.publicRelayUrl, issuer: relay.relayIssuer },
    settings.hostId,
  );
  for (let index = 0; index < 8; index++) {
    const provisioned = yield* provision.runOne();
    const enrolled = yield* enrollment.runOne();
    const moveStarted = yield* makeThreadVmMoveServerWorker(
      sql,
      makeE2BThreadVmServer(settings.compute),
      settings.hostId,
    ).runOne();
    if (!provisioned && !enrolled && !moveStarted) return;
  }
});

/** Bulk-object cleanup is independent of whether the VM host is currently enabled. */
export const reconcileThreadArtifacts = Effect.fn("relay.thread_artifact.reconcile")(function* () {
  const sql = (yield* RelayDb).$client;
  const objects = yield* ThreadArtifactObjectStorage;
  return yield* makeThreadArtifactTransfer(sql, objects).collectOne();
});

/** Read-only guest inspection; this never pauses, wakes, or deletes a VM. */
export const reconcileThreadVmActivity = Effect.fn("relay.thread_vm.reconcile_activity")(function* (
  settings: ThreadVmRuntimeSettings | undefined,
) {
  if (!settings) return;
  const sql = (yield* RelayDb).$client;
  const worker = makeThreadVmActivityWorker(
    sql,
    makeE2BThreadVmActivity(settings.compute),
    settings.hostId,
  );
  for (let index = 0; index < 8; index++) if (!(yield* worker.runOne())) return;
});

/** Pause only after a fresh idle report; the durable claim and guest seal fence work. */
export const reconcileThreadVmPauses = Effect.fn("relay.thread_vm.reconcile_pauses")(function* (
  settings: ThreadVmRuntimeSettings | undefined,
) {
  if (!settings?.autoPauseEnabled) return;
  const sql = (yield* RelayDb).$client;
  const worker = makeThreadVmPauseWorker(
    sql,
    makeE2BThreadVmCompute(settings.compute),
    makeE2BThreadVmPause(settings.compute),
    settings.hostId,
  );
  for (let index = 0; index < 4; index++) if (!(yield* worker.runOne())) return;
});

/** An explicit wake request waits for capacity, then verifies the running guest gate. */
export const reconcileThreadVmResumes = Effect.fn("relay.thread_vm.reconcile_resumes")(function* (
  settings: ThreadVmRuntimeSettings | undefined,
) {
  if (!settings) return;
  const sql = (yield* RelayDb).$client;
  const worker = makeThreadVmResumeWorker(
    sql,
    makeE2BThreadVmCompute(settings.compute),
    makeE2BThreadVmPause(settings.compute),
    settings.hostId,
  );
  for (let index = 0; index < 4; index++) if (!(yield* worker.runOne())) return;
});

/** Keep the infrastructure lease ahead of E2B's default pause while this relay is healthy. */
export const reconcileThreadVmLeases = Effect.fn("relay.thread_vm.reconcile_leases")(function* (
  settings: ThreadVmRuntimeSettings | undefined,
) {
  if (!settings) return;
  const sql = (yield* RelayDb).$client;
  const worker = makeThreadVmLeaseWorker(
    sql,
    makeE2BThreadVmLease(settings.compute),
    settings.hostId,
    makeE2BThreadVmCompute(settings.compute),
  );
  for (let index = 0; index < 8; index++) if (!(yield* worker.runOne())) return;
});

/** Default-off admission shares final-save safety; each sweep examines at most eight candidates. */
export const reconcileThreadVmIdleDeletion = Effect.fn("relay.thread_vm.reconcile_idle_deletion")(
  function* (settings: ThreadVmRuntimeSettings | undefined) {
    if (!settings?.autoDeleteEnabled || !settings.autoBackupEnabled) return;
    const sql = (yield* RelayDb).$client,
      objects = yield* ThreadArtifactObjectStorage;
    const worker = makeThreadVmIdleDeletionWorker(sql, objects, settings.hostId);
    for (let index = 0; index < 8; index++) if (!(yield* worker.runOne())) return;
  },
);

/** A backup is published only after a trusted cold probe stopped and its preparation was cancelled. */
export const reconcileThreadVmBackups = Effect.fn("relay.thread_vm.reconcile_backups")(function* (
  settings: ThreadVmRuntimeSettings | undefined,
) {
  if (!settings?.autoBackupEnabled) return;
  yield* reconcileThreadVmIdleDeletion(settings);
  const sql = (yield* RelayDb).$client;
  const compute = makeE2BThreadVmCompute(settings.compute);
  if (settings.replacementEnabled) {
    const objects = yield* ThreadArtifactObjectStorage;
    const replacements = makeThreadVmReplacementCoordinator(sql, objects);
    for (let index = 0; index < 8; index++)
      if (!(yield* replacements.runOne(settings.hostId))) break;
  }
  yield* makeThreadVmBackupRetentionWorker(sql, compute, settings.hostId).runOne();
  yield* makeThreadVmBackupWorker(sql, compute, settings.hostId).runOne();
  // Admission only requests a drain. Independently certified recovery and a verified
  // whole-disk save still precede every physical deletion.
  const finalSaves =
    yield* sql`SELECT 1 FROM relay_thread_vm_final_saves WHERE host_id=${settings.hostId} AND phase IN ('frozen','saving','deleting','aborting') LIMIT 1`;
  if (finalSaves.length) {
    const objects = yield* ThreadArtifactObjectStorage;
    yield* makeThreadVmFinalSaveAbortWorker(sql, objects, compute, settings.hostId).runOne();
    yield* makeThreadVmFinalSaveWorker(sql, objects, settings.hostId).runOne();
    yield* makeThreadVmFinalSaveDeletionWorker(sql, objects, compute, settings.hostId).runOne();
  }
  yield* makeThreadVmSavedDiskWorker(sql, compute, settings.hostId).runOne();
});
