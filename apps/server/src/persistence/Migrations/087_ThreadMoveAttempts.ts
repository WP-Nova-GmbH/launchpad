import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_move_attempts (
    operation_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    relay_url TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation > 0),
    attempt INTEGER NOT NULL CHECK(attempt > 0),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    acknowledged_revision INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged_revision >= 0 AND acknowledged_revision <= revision),
    ended INTEGER NOT NULL DEFAULT 0 CHECK(ended IN (0,1)),
    report_json TEXT CHECK(report_json IS NULL OR json_valid(report_json)),
    PRIMARY KEY(operation_id,environment_id,generation)
  )`;
});
