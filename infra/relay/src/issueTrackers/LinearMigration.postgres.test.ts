import * as FileSystem from "effect/FileSystem";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as PgClient from "@effect/sql-pg/PgClient";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
const url = process.env.LINEAR_REPLACEMENT_TEST_DATABASE_URL;
describe.skipIf(!url)("Linear dynamic OAuth migration", () => {
  it.effect("invalidates legacy grants and proposals without changing Jira", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const statements = (yield* fs.readFileString(
        new URL(
          "../../migrations/postgres/20261002090000_linear_dynamic_oauth/migration.sql",
          import.meta.url,
        ).pathname,
      )).split("--> statement-breakpoint");
      const sql = yield* PgClient.PgClient;
      const result = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            for (const org of ["linear-migration-active", "linear-migration-pending"]) {
              yield* sql`INSERT INTO relay_organizations (organization_id,name,created_at,updated_at) VALUES (${org},'Test','2026-01-01','2026-01-01') ON CONFLICT DO NOTHING`;
              yield* sql`DELETE FROM relay_issue_tracker_connections WHERE organization_id = ${org}`;
            }
            yield* sql`INSERT INTO relay_issue_tracker_connections (organization_id,service,version,status,payload_sealed,authorization_id,pending_oauth_sealed,pending_state_hash,pending_expires_at,replacement,updated_by_user_id,updated_at) VALUES
    ('linear-migration-active','linear','old-version','connected','legacy-secret','auth','pending-secret','pending-state','2099-01-01','{"payloadSealed":"replacement-secret"}','admin','2026-01-01'),
    ('linear-migration-pending','linear','pending-version','connecting',NULL,'auth',NULL,'pending-only-state','2099-01-01',NULL,'admin','2026-01-01'),
    ('linear-migration-active','jira','jira-version','connected','jira-secret',NULL,NULL,NULL,NULL,NULL,'admin','2026-01-01')`;
            for (const statement of statements) yield* sql.unsafe(statement);
            const rows = yield* sql<{
              service: string;
              version: string;
              status: string;
              payload_sealed: string | null;
              authorization_id: string | null;
              pending_oauth_sealed: string | null;
              pending_state_hash: string | null;
              pending_expires_at: string | null;
              replacement: unknown;
            }>`SELECT * FROM relay_issue_tracker_connections WHERE organization_id IN ('linear-migration-active','linear-migration-pending')`;
            expect(rows).toHaveLength(2);
            expect(rows.find((row) => row.service === "jira")).toMatchObject({
              version: "jira-version",
              status: "connected",
              payload_sealed: "jira-secret",
            });
            const linear = rows.find((row) => row.service === "linear");
            expect(linear).toMatchObject({
              status: "reconnect_required",
              payload_sealed: null,
              authorization_id: null,
              pending_oauth_sealed: null,
              pending_state_hash: null,
              pending_expires_at: null,
              replacement: null,
            });
            expect(linear?.version).not.toBe("old-version");
            return yield* Effect.fail("rollback-test" as const);
          }),
        )
        .pipe(Effect.flip);
      expect(result).toBe("rollback-test");
    }).pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(url ?? "") })),
      Effect.provide(NodeFileSystem.layer),
      Effect.scoped,
    ),
  );
});
