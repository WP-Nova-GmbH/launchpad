import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { Effect, Layer, Redacted, FileSystem } from "effect";
import { RelayDb } from "../db.ts";
import { make, type WorkflowJobRecord } from "./Workflows.ts";

const url = process.env.WORKFLOW_PAGES_TEST_DATABASE_URL;
const layer = Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(url ?? "") })),
  Layer.provideMerge(NodeFileSystem.layer),
);
describe.skipIf(!url)("automation origin (PostgreSQL)", () => {
  it.effect(
    "backfills manual origins, preserves queued and terminal state, and rejects downgrade writers",
    () =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const fs = yield* FileSystem.FileSystem;
        const outcome = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const initial = yield* fs.readFileString(
                new URL(
                  "../../migrations/postgres/20261008114100_repository_workflows/migration.sql",
                  import.meta.url,
                ).pathname,
              );
              for (const statement of initial.split("--> statement-breakpoint"))
                yield* sql.unsafe(statement.replace("CREATE TABLE", "CREATE TEMP TABLE"));
              for (const status of ["queued", "dispatching", "awaiting_review", "done"]) {
                const record = {
                  status,
                  instruction: "retained",
                  workflow: null,
                  progress: null,
                  requiredProtocol: 6,
                };
                yield* sql`INSERT INTO relay_workflow_jobs (job_id,repository_id,organization_id,submitter_user_id,status,record,revision,created_at,checked_at)
          VALUES (${status},'repo','org','alice',${status},${sql.json(record)},3,'now','now')`;
              }
              for (const migration of [
                "20261015110011_workflow_job_pages",
                "20261015151148_workflow_origin",
              ]) {
                const content = yield* fs.readFileString(
                  new URL(`../../migrations/postgres/${migration}/migration.sql`, import.meta.url)
                    .pathname,
                );
                for (const statement of content.split("--> statement-breakpoint"))
                  yield* sql.unsafe(statement);
              }
              const rows = yield* sql<{
                record: { origin: unknown; instruction: string };
                revision: number;
              }>`SELECT record, revision FROM relay_workflow_jobs`;
              expect(rows).toHaveLength(4);
              for (const row of rows) {
                expect(row.record.origin).toEqual({ kind: "manual", userId: "alice" });
                expect(row.record.instruction).toBe("retained");
                expect(row.revision).toBe(3);
              }
              const legacy = {
                jobId: "legacy-writer",
                workflowId: "flow",
                repositoryId: "repo",
                environmentId: "env",
                instruction: "Legacy writer",
                status: "queued",
                detail: null,
                workflow: null,
                progress: null,
                createdAt: "now",
                updatedAt: "now",
                requiredProtocol: 6,
              };
              yield* sql`INSERT INTO relay_workflow_jobs (job_id,repository_id,organization_id,submitter_user_id,status,record,revision,created_at,checked_at)
        VALUES ('legacy-writer','repo','org','bob','queued',${sql.json(legacy)},0,'now','now')`;
              const normalized = yield* sql<{
                record: { origin: unknown };
              }>`SELECT record FROM relay_workflow_jobs WHERE job_id = 'legacy-writer'`;
              expect(normalized[0]?.record.origin).toEqual({ kind: "manual", userId: "bob" });
              const store = yield* make;
              const origin = {
                kind: "automation" as const,
                organizationId: "org",
                repositoryId: "repo",
                workflowId: "flow",
                source: {
                  provider: "linear" as const,
                  applicationId: "app",
                  workspaceId: "ws",
                  connectionId: "connection",
                  grantId: "grant",
                },
                occurrenceId: "event",
              };
              const row: WorkflowJobRecord = {
                jobId: "auto",
                repositoryId: "repo",
                organizationId: "org",
                submitterUserId: null,
                repositoryCanonicalKey: null,
                status: "queued",
                revision: 0,
                leaseUntil: null,
                pendingControl: null,
                createdAt: "now",
                checkedAt: "now",
                record: {
                  jobId: "auto",
                  repositoryId: "repo",
                  workflowId: "flow",
                  environmentId: EnvironmentId.make("env"),
                  instruction: "context",
                  requiredProtocol: 8,
                  origin,
                  workflow: null,
                  progress: null,
                  status: "queued",
                  detail: null,
                  createdAt: "now",
                  updatedAt: "now",
                },
              };
              yield* store.createJob(row);
              expect((yield* store.getJob("auto"))?.submitterUserId).toBeNull();
              expect(
                (yield* store.pageJobs("repo", { view: "active" })).jobs.find(
                  (job) => job.jobId === "auto",
                )?.originSummary,
              ).toEqual({ kind: "automation" });
              const updated = yield* store.updateJob(row, { ...row.record, detail: "blocked" });
              expect(updated.record.origin).toEqual(origin);
              const invalid = yield* sql
                .withTransaction(
                  sql`UPDATE relay_workflow_jobs SET record = jsonb_set(record,'{requiredProtocol}','6'::jsonb) WHERE job_id = 'auto'`,
                )
                .pipe(Effect.exit);
              expect(invalid._tag).toBe("Failure");
              return yield* Effect.fail("rollback-origin" as const);
            }),
          )
          .pipe(Effect.flip);
        expect(outcome).toBe("rollback-origin");
      }).pipe(Effect.provide(layer)),
  );
});
