import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE checkout_operations (
    operation_id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('vcs', 'write-file'))
  )`;
  yield* sql`CREATE TABLE checkout_operation_paths (
    operation_id TEXT NOT NULL REFERENCES checkout_operations(operation_id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    PRIMARY KEY(operation_id, path)
  )`;
  yield* sql`CREATE TABLE checkout_operation_projects (
    operation_id TEXT NOT NULL REFERENCES checkout_operations(operation_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    PRIMARY KEY(operation_id, project_id)
  )`;
  yield* sql`CREATE INDEX checkout_operations_by_project ON checkout_operation_projects(project_id)`;
});
