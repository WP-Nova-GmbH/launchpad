import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_transfer_readiness (
    operation_id TEXT PRIMARY KEY NOT NULL REFERENCES thread_checkout_claims(operation_id),
    manifest_sha256 TEXT NOT NULL,
    native_runtime_json TEXT NOT NULL,
    setup_sha256 TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('started', 'ready'))
  )`;
});
