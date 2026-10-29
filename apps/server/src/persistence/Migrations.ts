/**
 * Migration runner with an inline loader.
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * `runMigrations` is called by the SQLite persistence layer at startup, so the
 * schema is always up to date before the application starts.
 */

import * as Migrator from "effect/unstable/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  checkMigrationHistory,
  combinedReaderMarker,
  legacyWorkflowOffset,
} from "./MigrationCompatibility.ts";
export { combinedReaderMarker } from "./MigrationCompatibility.ts";

// Import all migrations statically
import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "./Migrations/038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0040 from "./Migrations/040_ProjectionProjectFaviconPath.ts";
import Migration0041 from "./Migrations/041_AuthSessionClientConnection.ts";
import Migration0042 from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Migration0043 from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";
import Migration0044 from "./Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Migration0045 from "./Migrations/045_ProjectionProjectsAutoPull.ts";
import Migration0046 from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration0047 from "./Migrations/047_ProjectionProjectIcon.ts";
import Migration0048 from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
import Migration0049 from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import Migration0050 from "./Migrations/050_ProjectionThreadPullRequests.ts";
import Migration0051 from "./Migrations/051_ProjectionThreadMessageContext.ts";
import Migration0052 from "./Migrations/052_ProjectionThreadTitleState.ts";
import Migration0053 from "./Migrations/053_PullRequestFilesViewed.ts";
import Migration0054 from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import Migration0055 from "./Migrations/055_AuthSessionUser.ts";
import Migration0056 from "./Migrations/056_ProjectionThreadMessageAuthor.ts";
import Migration0057 from "./Migrations/057_SharedPromptQueue.ts";
import Migration0058 from "./Migrations/058_CommandReceiptProjectScope.ts";
import Migration0059 from "./Migrations/059_ThreadCleanupFences.ts";
import Migration0060 from "./Migrations/060_ThreadExecutionFences.ts";
import Migration0061 from "./Migrations/061_ThreadTransferBaselines.ts";
import Migration0062 from "./Migrations/062_ThreadCheckoutClaims.ts";
import Migration0063 from "./Migrations/063_ThreadTransferRuntime.ts";
import Migration0064 from "./Migrations/064_CheckoutOperations.ts";
import Migration0065 from "./Migrations/065_ThreadTransferReadiness.ts";
import Migration0066 from "./Migrations/066_ThreadMoveQueue.ts";
import Migration0067 from "./Migrations/067_ThreadNativeCheckpoints.ts";
import Migration0068 from "./Migrations/068_ThreadAttachmentCheckpoints.ts";
import Migration0069 from "./Migrations/069_FrozenThreadCheckpoints.ts";
import Migration0070 from "./Migrations/070_ThreadTransferAborts.ts";
import Migration0071 from "./Migrations/071_ThreadTransferSetupOutput.ts";
import Migration0074 from "./Migrations/074_ThreadLocalEnrollmentAbort.ts";
import Migration0073 from "./Migrations/073_ThreadLocalEnrollment.ts";
import Migration0072 from "./Migrations/072_ThreadVmMoveCheckout.ts";
import Migration0075 from "./Migrations/075_CheckoutCapture.ts";

import Migration0076 from "./Migrations/076_RepositoryWorkflowJobs.ts";
import Migration0077 from "./Migrations/077_WorkflowCancellationFences.ts";
import Migration0078 from "./Migrations/078_SetupProcessOwnership.ts";
import Migration0079 from "./Migrations/079_SetupCleanupEvidence.ts";
import Migration0080 from "./Migrations/080_SetupLifecycleCleanup.ts";
import Migration0081 from "./Migrations/081_WorkflowSteps.ts";
import Migration0082 from "./Migrations/082_WorkflowManualPause.ts";
import Migration0083 from "./Migrations/083_WorkflowOrigin.ts";
import Migration0084 from "./Migrations/084_WorkflowPortableReader.ts";
import Migration0085 from "./Migrations/085_ThreadTransferProbeReceipt.ts";
/**
 * Migration loader with all migrations defined inline.
 *
 * Key format: "{id}_{name}" where:
 * - id: numeric migration ID (determines execution order)
 * - name: descriptive name for the migration
 *
 * Uses Migrator.fromRecord which parses the key format and
 * returns migrations sorted by ID.
 */
const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionThreadsSettled", Migration0033],
  [34, "ProjectionThreadsSnoozed", Migration0034],
  [35, "ProjectionThreadTitleRegeneration", Migration0035],
  [36, "ProjectionThreadsPinned", Migration0036],
  [37, "ProjectionTurnsKeysetIndex", Migration0037],
  [38, "ProjectionThreadsPinOrderKey", Migration0038],
  [39, "ProjectionProjectsDefaultThreadEnvMode", Migration0039],
  [40, "ProjectionProjectFaviconPath", Migration0040],
  [41, "AuthSessionClientConnection", Migration0041],
  [42, "ProjectionThreadLinkedPullRequest", Migration0042],
  [43, "ProjectionThreadsUnsettledAt", Migration0043],
  [44, "ClearAutomaticProjectModelDefaults", Migration0044],
  [45, "ProjectionProjectsAutoPull", Migration0045],
  [46, "RepairAutomaticSettlementTimestamps", Migration0046],
  [47, "ProjectionProjectIcon", Migration0047],
  [48, "ProjectionThreadBranchPullRequest", Migration0048],
  [49, "ProjectionThreadsActiveOrderKey", Migration0049],
  [50, "ProjectionThreadPullRequests", Migration0050],
  [51, "ProjectionThreadMessageContext", Migration0051],
  [52, "ProjectionThreadTitleState", Migration0052],
  [53, "PullRequestFilesViewed", Migration0053],
  [54, "ProjectionThreadsAutoSettleDisabledAt", Migration0054],
  [55, "AuthSessionUser", Migration0055],
  [56, "ProjectionThreadMessageAuthor", Migration0056],
  [57, "SharedPromptQueue", Migration0057],
  [58, "CommandReceiptProjectScope", Migration0058],
  [59, "ThreadCleanupFences", Migration0059],
  [60, "ThreadExecutionFences", Migration0060],
  [61, "ThreadTransferBaselines", Migration0061],
  [62, "ThreadCheckoutClaims", Migration0062],
  [63, "ThreadTransferRuntime", Migration0063],
  [64, "CheckoutOperations", Migration0064],
  [65, "ThreadTransferReadiness", Migration0065],
  [66, "ThreadMoveQueue", Migration0066],
  [67, "ThreadNativeCheckpoints", Migration0067],
  [68, "ThreadAttachmentCheckpoints", Migration0068],
  [69, "FrozenThreadCheckpoints", Migration0069],
  [70, "ThreadTransferAborts", Migration0070],
  [71, "ThreadTransferSetupOutput", Migration0071],
  [72, "ThreadVmMoveCheckout", Migration0072],
  [73, "ThreadLocalEnrollment", Migration0073],
  [74, "ThreadLocalEnrollmentAbort", Migration0074],
  [75, "CheckoutCapture", Migration0075],
  [76, "RepositoryWorkflowJobs", Migration0076],
  [77, "WorkflowCancellationFences", Migration0077],
  [78, "SetupProcessOwnership", Migration0078],
  [79, "SetupCleanupEvidence", Migration0079],
  [80, "SetupLifecycleCleanup", Migration0080],
  [81, "WorkflowSteps", Migration0081],
  [82, "WorkflowManualPause", Migration0082],
  [83, "WorkflowOrigin", Migration0083],
  [84, "WorkflowPortableReader", Migration0084],
  [85, "ThreadTransferProbeReceipt", Migration0085],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

// Previous builds ignore newer migration ids but reject changed names of known
// migrations. Keep this reader barrier after activation: downgrading would lose
// both repository enforcement and the durable queue without warning.
export const sharedThreadReaderMarker = "OrchestrationEvents_SharedThreadReaderV2";
export const markSharedThreadDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE effect_sql_migrations SET name = ${sharedThreadReaderMarker}
    WHERE migration_id = 1 AND name IN ('OrchestrationEvents', 'OrchestrationEvents_SharedThreadReaderV1')`;
});

const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

/**
 * Migrator run function - no schema dumping needed
 * Uses the base Migrator.make without platform dependencies
 */
const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/**
 * Migrations this build moved to a higher id after upstream took their old ids.
 * A database that ran them under the old id has the schema but the wrong
 * record. The migrator only runs ids above the highest recorded one, so the
 * stale record is dropped rather than moved: the upstream migrations that now
 * own the old ids run, and the moved migration reruns under its new id. Every
 * migration listed here must therefore be safe to run twice.
 */
const renumberedMigrations: ReadonlyArray<{ readonly oldId: number; readonly name: string }> = [
  { oldId: 41, name: "AuthSessionUser" },
  { oldId: 42, name: "ProjectionThreadMessageAuthor" },
];

const forgetRenumberedMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const { oldId, name } of renumberedMigrations) {
    const stale = yield* sql<{ migration_id: number }>`
      SELECT migration_id FROM effect_sql_migrations
      WHERE migration_id = ${oldId} AND name = ${name}
    `.withoutTransform;
    if (stale.length === 0) {
      continue;
    }
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${oldId} AND name = ${name}`;
    yield* Effect.log("Forgot a renumbered migration so its successors run").pipe(
      Effect.annotateLogs({ migration: `${oldId}_${name}` }),
    );
  }
});

/** Read-only validation is shared by the dev snapshot tool. */
export const verifyMigrationHistory = checkMigrationHistory(migrationManifest);

/**
 * Run all pending migrations.
 *
 * Creates the migrations tracking table (effect_sql_migrations) if it doesn't exist,
 * then runs any migrations with ID greater than the latest recorded migration.
 *
 * Returns array of [id, name] tuples for migrations that were run.
 *
 * @returns Effect containing array of executed migrations
 */
export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  const sql = yield* SqlClient.SqlClient;
  const executedMigrations = yield* sql.withTransaction(
    Effect.gen(function* () {
      const table =
        yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
      if (table.length) yield* forgetRenumberedMigrations;
      const history = yield* verifyMigrationHistory;
      const executed: Array<readonly [number, string]> = [];
      if (history.kind === "legacy-workflow") {
        if (toMigrationInclusive !== undefined && toMigrationInclusive < 84)
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "Legacy workflow history requires the complete combined migration.",
          });
        // Do not move these rows above the VM watermark until every VM schema exists.
        // The outer transaction also rolls back nested migrator receipts and DDL.
        const original = yield* sql<{
          migration_id: number;
          name: string;
          created_at: string;
        }>`SELECT migration_id, name, created_at FROM effect_sql_migrations WHERE migration_id >= 60 ORDER BY migration_id`
          .withoutTransform;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 60`;
        executed.push(...(yield* run({ loader: makeMigrationLoader(75) })));
        const installed = yield* sql<{
          migration_id: number;
          name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id BETWEEN 60 AND 75`
          .withoutTransform;
        if (
          !migrationManifest
            .filter(([id]) => id >= 60 && id <= 75)
            .every(([id, name]) =>
              installed.some((row) => row.migration_id === id && row.name === name),
            )
        )
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "VM migration history did not complete before workflow remapping.",
          });
        for (const row of original)
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (${row.migration_id + legacyWorkflowOffset}, ${row.name}, ${row.created_at})`;
      }
      const target = toMigrationInclusive ?? 85;
      if (target >= 76 && history.through < 84)
        yield* sql`DROP TRIGGER IF EXISTS checkout_capture_preserve_reader_barrier`;
      executed.push(...(yield* run({ loader: makeMigrationLoader(toMigrationInclusive) })));
      if (target >= 84 && history.readerActivated)
        yield* sql`UPDATE effect_sql_migrations SET name = ${combinedReaderMarker} WHERE migration_id = 1`;
      yield* verifyMigrationHistory;
      const final = yield* sql<{
        migration_id: number;
        name: string;
      }>`SELECT migration_id, name FROM effect_sql_migrations`.withoutTransform;
      if (
        !migrationManifest
          .filter(([id]) => id <= target)
          .every(([id, name]) =>
            final.some((row) => row.migration_id === id && (row.name === name || id === 1)),
          )
      )
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Required migration prefix is incomplete.",
        });
      return executed;
    }),
  );
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});
