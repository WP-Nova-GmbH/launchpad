import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Sessions minted through Launchpad Connect learn who the signed-in person
 * is. The identity rides the pairing link into the session it becomes, so
 * both tables gain the same nullable JSON column.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const pairingLinkColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_pairing_links)
  `;
  if (!pairingLinkColumns.some((column) => column.name === "user_json")) {
    yield* sql`
      ALTER TABLE auth_pairing_links
      ADD COLUMN user_json TEXT
    `;
  }

  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;
  if (!sessionColumns.some((column) => column.name === "user_json")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN user_json TEXT
    `;
  }
});
