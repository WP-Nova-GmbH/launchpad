import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** User messages on shared executors remember who sent them. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;

  if (!columns.some((column) => column.name === "author_json")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN author_json TEXT
    `;
  }
});
