import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE checkout_capture_holds ADD COLUMN boot_json TEXT`;
  yield* sql`CREATE TABLE thread_move_source_reopens (
    operation_id TEXT NOT NULL PRIMARY KEY,
    thread_id TEXT NOT NULL,
    relay_url TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation > 0),
    message_id TEXT NOT NULL
  )`;
});
