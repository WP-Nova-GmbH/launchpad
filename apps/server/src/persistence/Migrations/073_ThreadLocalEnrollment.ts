import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  yield* (yield* SqlClient.SqlClient)`CREATE TABLE thread_local_enrollments (
    thread_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
    relay_url TEXT NOT NULL, environment_id TEXT NOT NULL, canonical_key TEXT NOT NULL, actor_user_id TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'pending' CHECK(phase IN ('pending','active')))`;
});
