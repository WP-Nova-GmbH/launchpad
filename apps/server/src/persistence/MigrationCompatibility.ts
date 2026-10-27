import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const legacyWorkflowOffset = 16;
export const combinedReaderMarker = "OrchestrationEvents_WorkflowPortableReaderV1";
export const workflowNames = [
  "RepositoryWorkflowJobs",
  "WorkflowCancellationFences",
  "SetupProcessOwnership",
  "SetupCleanupEvidence",
  "SetupLifecycleCleanup",
  "WorkflowSteps",
  "WorkflowManualPause",
  "WorkflowOrigin",
] as const;
const workflowMarker = (version: number) => `OrchestrationEvents_WorkflowReaderV${version}`;
const vmMarkers = new Map([
  ["OrchestrationEvents_PortableThreadReaderV1", 60],
  ["OrchestrationEvents_ThreadMoveQueueReaderV1", 66],
  ["OrchestrationEvents_FrozenCheckpointReaderV1", 69],
  ["OrchestrationEvents_TransferAbortReaderV1", 70],
  ["OrchestrationEvents_CheckoutCaptureReaderV1", 75],
]);
const fail = (message: string) =>
  new Migrator.MigrationError({
    kind: "BadState",
    message: `Recorded migrations do not match this build: ${message}`,
  });
const workflowTables = [
  [1, "repository_workflow_jobs", "job_id,thread_id,status,execution_reserved,record_json"],
  [2, "repository_workflow_cancellations", "job_id,record_json"],
  [3, "setup_processes", "thread_id,attempt_id,record_json"],
  [3, "setup_process_cleanup", "thread_id,attempt_id,command_id,state,detail"],
] as const;
const vmTables = [
  [60, "thread_execution_fences"],
  [60, "thread_relay_command_deliveries"],
  [60, "thread_relay_history_cursors"],
  [60, "thread_execution_work"],
  [61, "thread_transfer_baselines"],
  [62, "thread_checkout_claims"],
  [62, "thread_checkout_claim_projects"],
  [64, "checkout_operations"],
  [64, "checkout_operation_paths"],
  [64, "checkout_operation_projects"],
  [65, "thread_transfer_readiness"],
  [67, "thread_native_checkpoints"],
  [68, "thread_attachment_checkpoints"],
  [70, "thread_transfer_aborts"],
  [73, "thread_local_enrollments"],
  [74, "thread_local_enrollment_aborts"],
  [75, "checkout_capture_holds"],
  [75, "checkout_work_admissions"],
] as const;

const vmColumns: Readonly<Record<string, string>> = {
  thread_execution_fences:
    "thread_id,relay_url,environment_id,project_id,generation,operation_id,phase,frozen_sequence",
  thread_relay_command_deliveries:
    "command_id,thread_id,generation,position,entry_json,normalized_json,receipt_json,settled",
  thread_relay_history_cursors: "thread_id,generation,source_sequence",
  thread_execution_work: "thread_id,work_id,generation,kind,started,completed,relay_completed",
  thread_transfer_baselines:
    "operation_id,thread_id,generation,manifest_sha256,history_sha256,receipts_sha256,source_environment_id,source_sequence,destination_sequence",
  thread_checkout_claims:
    "operation_id,thread_id,generation,project_id,repository_root,checkout_path,mode,branch,manifest_sha256,workspace_sha256,inspection_json,backup_directory,backup_sha256,release_reason,phase",
  thread_checkout_claim_projects: "operation_id,project_id",
  checkout_operations: "operation_id,kind",
  checkout_operation_paths: "operation_id,path",
  checkout_operation_projects: "operation_id,project_id",
  thread_transfer_readiness: "operation_id,manifest_sha256,native_runtime_json,setup_sha256,phase",
  thread_native_checkpoints:
    "thread_id,turn_id,environment_id,generation,source_sequence,native_thread_id,directory,manifest_sha256,archive_sha256,published_artifact_id",
  thread_attachment_checkpoints:
    "thread_id,generation,turn_id,environment_id,source_sequence,directory,manifest_sha256,published_artifact_id",
  thread_transfer_aborts: "operation_id,thread_id,environment_id,generation",
  thread_local_enrollments:
    "thread_id,operation_id,project_id,relay_url,environment_id,canonical_key,actor_user_id,phase",
  thread_local_enrollment_aborts: "operation_id,thread_id,move_operation_id",
  checkout_capture_holds:
    "operation_id,thread_id,environment_id,generation,checkout_root,git_common_root,admission_sequence,phase,release_outcome,manifest_sha256",
  checkout_work_admissions:
    "sequence,admission_id,thread_id,work_id,kind,checkout_root,git_common_root,parent_admission_id,lineage_sequence,turn_id,turn_finalized,completed,rejected",
};

const verifySchema = Effect.fn("MigrationCompatibility.verifySchema")(function* (
  version: number,
  vmThrough: number,
  combined: boolean,
) {
  const sql = yield* SqlClient.SqlClient;
  const schema = yield* sql<{
    name: string;
    type: string;
    sql: string | null;
  }>`SELECT name, type, sql FROM sqlite_master`;
  const columns = (table: string) =>
    sql<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>`PRAGMA table_info(${sql(table)})`;
  for (const [introduced, table, expected] of workflowTables) {
    const exists = schema.some((entry) => entry.type === "table" && entry.name === table);
    if (exists !== version >= introduced) return yield* fail(`Unexpected workflow table ${table}.`);
    if (!exists) continue;
    const actual = yield* columns(table);
    const primaryKey =
      table === "repository_workflow_jobs" || table === "repository_workflow_cancellations"
        ? [1, 0, ...Array.from({ length: actual.length - 2 }, () => 0)]
        : table === "setup_processes"
          ? [1, 2, 0]
          : [1, 2, 3, 0, 0];
    if (
      actual.map((column) => column.name).join(",") !== expected ||
      actual.some(
        (column) => column.type !== (column.name === "execution_reserved" ? "INTEGER" : "TEXT"),
      ) ||
      actual.some(
        (column, index) =>
          column.pk !== primaryKey[index] || column.notnull !== (column.name === "detail" ? 0 : 1),
      )
    )
      return yield* fail(`Workflow schema does not match the recorded migration for ${table}.`);
  }
  const messageColumns = yield* columns("projection_thread_messages");
  if (messageColumns.some((column) => column.name === "workflow_origin_json") !== version >= 8)
    return yield* fail("Workflow attribution column does not match migration history.");
  if (version > 0) {
    for (const name of ["repository_workflow_jobs_status", "repository_workflow_execution_slot"])
      if (!schema.some((entry) => entry.type === "index" && entry.name === name))
        return yield* fail(`Workflow index ${name} is missing.`);
    const expectedTriggers =
      version === 1
        ? ["workflow_reader_barrier"]
        : [
            "workflow_reader_barrier_repository_workflow_jobs",
            "workflow_reader_barrier_repository_workflow_cancellations",
            ...(version >= 3 ? ["workflow_reader_barrier_setup_processes"] : []),
            ...(version >= 5 ? ["workflow_reader_barrier_thread_cleanup_fences"] : []),
            ...(version >= 8
              ? ["workflow_attribution_barrier_INSERT", "workflow_attribution_barrier_UPDATE"]
              : []),
          ];
    if (!combined) expectedTriggers.push("workflow_reader_barrier_preserve");
    const actual = schema.filter(
      (entry) =>
        entry.type === "trigger" &&
        entry.name.startsWith("workflow_") &&
        entry.name !== "workflow_portable_reader_preserve",
    );
    if (
      actual.length !== expectedTriggers.length ||
      expectedTriggers.some(
        (name) =>
          !actual.some(
            (entry) => entry.name === name && entry.sql?.includes(workflowMarker(version)),
          ),
      )
    )
      return yield* fail("Workflow reader triggers do not match the recorded migration.");
  }
  for (const [introduced, name] of vmTables) {
    if (
      schema.some((entry) => entry.type === "table" && entry.name === name) !==
      vmThrough >= introduced
    )
      return yield* fail(`VM schema does not match migration history for ${name}.`);
  }
  for (const [introduced, table] of vmTables) {
    if (vmThrough < introduced) continue;
    let expected = vmColumns[table];
    if (table === "thread_transfer_baselines" && vmThrough >= 63)
      expected += ",native_runtime_json";
    if (table === "thread_checkout_claims" && vmThrough >= 72) expected += ",fresh_checkout";
    if (table === "thread_transfer_readiness" && vmThrough >= 71)
      expected += ",setup_output_json,setup_started";
    if (table === "thread_native_checkpoints" && vmThrough >= 69)
      expected =
        "thread_id,generation,checkpoint_id,turn_id,capture_operation_id,environment_id,source_sequence,native_thread_id,directory,manifest_sha256,archive_sha256,published_artifact_id";
    if (table === "thread_attachment_checkpoints" && vmThrough >= 69)
      expected =
        "thread_id,generation,checkpoint_id,turn_id,environment_id,source_sequence,directory,manifest_sha256,published_artifact_id";
    if ((yield* columns(table)).map((column) => column.name).join(",") !== expected)
      return yield* fail(`VM columns do not match migration history for ${table}.`);
  }
  for (const [introduced, name] of [
    [59, "thread_cleanup_fence_on_delete"],
    [60, "portable_thread_reader_barrier"],
    [66, "thread_move_queue_reader_barrier"],
    [66, "thread_move_baseline_reader_barrier"],
    [69, "frozen_checkpoint_reader_barrier"],
    [70, "transfer_abort_reader_barrier"],
    [75, "checkout_capture_holds_reader_barrier"],
    [75, "checkout_work_admissions_reader_barrier"],
  ] as const) {
    if (
      vmThrough >= introduced &&
      !schema.some(
        (entry) =>
          entry.type === "trigger" &&
          entry.name === name &&
          entry.sql?.includes("effect_sql_migrations"),
      )
    )
      return yield* fail(`VM reader trigger ${name} is missing.`);
  }
  for (const [introduced, table, column] of [
    [63, "thread_transfer_baselines", "native_runtime_json"],
    [69, "thread_native_checkpoints", "checkpoint_id"],
    [69, "thread_native_checkpoints", "capture_operation_id"],
    [69, "thread_attachment_checkpoints", "checkpoint_id"],
    [71, "thread_transfer_readiness", "setup_output_json"],
    [71, "thread_transfer_readiness", "setup_started"],
    [72, "thread_checkout_claims", "fresh_checkout"],
  ] as const) {
    if ((yield* columns(table)).some((entry) => entry.name === column) !== vmThrough >= introduced)
      return yield* fail(`VM column ${table}.${column} does not match migration history.`);
  }
  if (
    combined &&
    !schema.some(
      (entry) =>
        entry.type === "trigger" &&
        entry.name === "workflow_portable_reader_preserve" &&
        entry.sql?.includes(combinedReaderMarker),
    )
  )
    return yield* fail("The combined reader barrier is missing.");
});

/** Recognizes only the two shipped histories, before any ledger writes. */
export const checkMigrationHistory = (manifest: ReadonlyArray<readonly [number, string]>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (
      !(yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`)
        .length
    )
      return { kind: "canonical" as const, readerActivated: false, through: 0 };
    const raw = yield* sql<{
      migration_id: number;
      name: string;
    }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`.withoutTransform;
    // These two idempotent migrations already have a narrowly supported old slot.
    const recorded = raw.filter(
      (row) =>
        !(
          (row.migration_id === 41 && row.name === "AuthSessionUser") ||
          (row.migration_id === 42 && row.name === "ProjectionThreadMessageAuthor")
        ),
    );
    if (recorded.some((row) => row.migration_id < 1))
      return yield* fail("Migration IDs must be positive.");
    const legacy = recorded.some((row) => row.migration_id === 60 && row.name === workflowNames[0]);
    const highest = Math.max(0, ...recorded.map((row) => row.migration_id));
    const through = Math.min(highest, 84);
    const marker = recorded.find((row) => row.migration_id === 1)?.name;
    const has = (id: number, name: string) =>
      recorded.some((row) => row.migration_id === id && row.name === name);
    const expected = new Map<number, string>(manifest);
    const sharedMarker =
      (marker === "OrchestrationEvents_SharedThreadReaderV1" && has(57, "SharedPromptQueue")) ||
      (marker === "OrchestrationEvents_SharedThreadReaderV2" &&
        has(57, "SharedPromptQueue") &&
        has(58, "CommandReceiptProjectScope")) ||
      (marker === "OrchestrationEvents_ThreadCleanupReaderV1" && has(59, "ThreadCleanupFences"));
    const workflowVersion = legacy ? highest - 59 : Math.max(0, through - 75);
    const vmThrough = legacy ? 59 : Math.min(through, 75);
    const workflowBarrier = Array.from({ length: Math.min(workflowVersion, 8) }, (_, index) =>
      workflowMarker(index + 1),
    ).includes(marker ?? "");
    const vmVersion = vmMarkers.get(marker ?? "");
    const combined = !legacy && through === 84;
    const knownMarker =
      marker === "OrchestrationEvents" ||
      sharedMarker ||
      workflowBarrier ||
      (!legacy && vmVersion !== undefined && vmVersion <= vmThrough) ||
      (marker === combinedReaderMarker && combined);
    if (recorded.length && !knownMarker)
      return yield* fail(`Invalid reader marker ${marker ?? "missing"}.`);
    const limit = legacy ? highest : through;
    if (legacy && (highest > 67 || highest < 60))
      return yield* fail("Legacy workflow history contains conflicting or future IDs.");
    for (let id = 1; id <= limit; id++) {
      const name = legacy && id >= 60 ? workflowNames[id - 60] : expected.get(id);
      const row = recorded.find((entry) => entry.migration_id === id);
      if (!row || (id !== 1 && row.name !== name))
        return yield* fail(
          `migration ${id}: database recorded "${row?.name ?? "missing"}", this build defines "${name}".`,
        );
    }
    // Unknown future rows remain tolerated only after the complete known prefix.
    if (!legacy && highest > 84 && through !== 84)
      return yield* fail("Future migration skips the required prefix.");
    if (through >= 59) yield* verifySchema(Math.min(workflowVersion, 8), vmThrough, combined);
    return {
      kind: legacy ? ("legacy-workflow" as const) : ("canonical" as const),
      readerActivated:
        workflowBarrier ||
        vmVersion !== undefined ||
        marker === combinedReaderMarker ||
        marker === "OrchestrationEvents_ThreadCleanupReaderV1",
      through,
    };
  });
