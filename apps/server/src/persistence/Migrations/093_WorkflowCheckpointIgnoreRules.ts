import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE workflow_vm_checkpoint_pins
    ADD COLUMN workflow_ignore_rules BLOB CHECK (workflow_ignore_rules IS NULL OR turn_count = 0)`;
});
