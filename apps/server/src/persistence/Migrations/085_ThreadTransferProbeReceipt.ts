import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE thread_transfer_readiness ADD COLUMN setup_succeeded INTEGER NOT NULL DEFAULT 0 CHECK(setup_succeeded IN (0,1))`;
  yield* sql`ALTER TABLE thread_transfer_readiness ADD COLUMN provider_probe_attempt_id TEXT`;
  yield* sql`CREATE UNIQUE INDEX idx_thread_transfer_provider_probe_attempt ON thread_transfer_readiness(provider_probe_attempt_id) WHERE provider_probe_attempt_id IS NOT NULL`;
  yield* sql`UPDATE thread_transfer_readiness SET setup_succeeded=1 WHERE phase='ready'`;
});
