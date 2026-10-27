import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_checkout_claims (
    operation_id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES thread_execution_fences(thread_id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    project_id TEXT NOT NULL,
    repository_root TEXT NOT NULL,
    checkout_path TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('main', 'worktree')),
    branch TEXT,
    manifest_sha256 TEXT NOT NULL,
    workspace_sha256 TEXT NOT NULL,
    inspection_json TEXT NOT NULL,
    backup_directory TEXT,
    backup_sha256 TEXT,
    release_reason TEXT CHECK (release_reason IN ('activated', 'cancelled')),
    phase TEXT NOT NULL CHECK (phase IN ('reserved', 'installing', 'installed', 'rolling-back', 'released')),
    UNIQUE(thread_id, generation)
  )`;
  yield* sql`CREATE UNIQUE INDEX thread_checkout_claim_path
    ON thread_checkout_claims(checkout_path) WHERE phase <> 'released'`;
  yield* sql`CREATE UNIQUE INDEX thread_checkout_claim_repository
    ON thread_checkout_claims(repository_root) WHERE phase <> 'released'`;
  yield* sql`CREATE TABLE thread_checkout_claim_projects (
    operation_id TEXT NOT NULL REFERENCES thread_checkout_claims(operation_id),
    project_id TEXT NOT NULL,
    PRIMARY KEY(operation_id, project_id)
  )`;
});
