import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import { runMigrations } from "./Migrations.ts";
// The original workflow migration bodies are retained verbatim at their new IDs.
import Jobs from "./Migrations/076_RepositoryWorkflowJobs.ts";
import Cancellations from "./Migrations/077_WorkflowCancellationFences.ts";
import Ownership from "./Migrations/078_SetupProcessOwnership.ts";
import Cleanup from "./Migrations/079_SetupCleanupEvidence.ts";
import Lifecycle from "./Migrations/080_SetupLifecycleCleanup.ts";
import Steps from "./Migrations/081_WorkflowSteps.ts";
import Pause from "./Migrations/082_WorkflowManualPause.ts";
import Origin from "./Migrations/083_WorkflowOrigin.ts";

export const originalWorkflowMigrations = [
  [60, "RepositoryWorkflowJobs", Jobs],
  [61, "WorkflowCancellationFences", Cancellations],
  [62, "SetupProcessOwnership", Ownership],
  [63, "SetupCleanupEvidence", Cleanup],
  [64, "SetupLifecycleCleanup", Lifecycle],
  [65, "WorkflowSteps", Steps],
  [66, "WorkflowManualPause", Pause],
  [67, "WorkflowOrigin", Origin],
] as const;
export const legacyWorkflowDatabase = Effect.fn("legacyWorkflowDatabase")(function* (through = 67) {
  yield* runMigrations({ toMigrationInclusive: 59 });
  yield* Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        originalWorkflowMigrations
          .filter(([id]) => id <= through)
          .map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
});
