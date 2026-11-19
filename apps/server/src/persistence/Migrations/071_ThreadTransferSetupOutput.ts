import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE thread_transfer_readiness ADD COLUMN setup_output_json TEXT`;
  yield* sql`ALTER TABLE thread_transfer_readiness ADD COLUMN setup_started INTEGER NOT NULL DEFAULT 0 CHECK(setup_started IN (0,1))`;
});
