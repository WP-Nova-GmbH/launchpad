import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE thread_move_attempts ADD COLUMN blocked_detail TEXT`;
  yield* sql`ALTER TABLE thread_transfer_readiness ADD COLUMN native_probe_fingerprint TEXT`;
  yield* sql`ALTER TABLE thread_transfer_readiness ADD COLUMN stopped_probe_preflight_fingerprint TEXT
    CHECK (stopped_probe_preflight_fingerprint IS NULL OR (provider_probe_attempt_id IS NOT NULL AND phase='started'))`;
  yield* sql`ALTER TABLE thread_transfer_readiness ADD COLUMN stopped_probe_runtime_key TEXT
    CHECK ((stopped_probe_preflight_fingerprint IS NULL) = (stopped_probe_runtime_key IS NULL))`;
});
