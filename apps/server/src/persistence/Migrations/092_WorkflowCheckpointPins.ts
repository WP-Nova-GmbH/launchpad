import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workflow_vm_checkpoint_pins (
    job_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    allocation_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    turn_id TEXT NOT NULL,
    turn_count INTEGER NOT NULL,
    preparation_attempt_id TEXT,
    checkpoint_ref TEXT NOT NULL,
    commit_id TEXT NOT NULL,
    tree_id TEXT NOT NULL,
    baseline_commit_id TEXT NOT NULL,
    PRIMARY KEY(job_id, allocation_id, operation_id, environment_id, generation, turn_id),
    CHECK ((turn_count = 0 AND turn_id = '') OR (turn_count > 0 AND turn_id <> ''))
  )`;
});
