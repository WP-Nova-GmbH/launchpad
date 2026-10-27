import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE thread_checkout_claims ADD COLUMN fresh_checkout INTEGER NOT NULL DEFAULT 0 CHECK(fresh_checkout IN (0,1))`;
});
