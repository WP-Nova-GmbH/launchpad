import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  yield* (yield* SqlClient.SqlClient)`CREATE TABLE thread_local_enrollment_aborts(
    operation_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,move_operation_id TEXT NOT NULL)`;
});
