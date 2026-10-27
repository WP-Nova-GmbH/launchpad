import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Schema, Effect, Layer, Redacted, FileSystem } from "effect";
import {
  WorkflowInvalidError,
  RepositoryWorkflowJobSummary,
  type WorkflowJobPage,
} from "@t3tools/contracts/workflows";
import { RelayDb } from "../db.ts";
import { make, type WorkflowJobRecord } from "./Workflows.ts";

// Opt in explicitly; every table/index is connection-local and rolled back.
const url = process.env.WORKFLOW_PAGES_TEST_DATABASE_URL;
const isJobSummary = Schema.is(RepositoryWorkflowJobSummary);
const layer = Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(url ?? "") })),
  Layer.provideMerge(NodeFileSystem.layer),
);
const job = (
  jobId: string,
  status: WorkflowJobRecord["status"] = "running",
  repositoryId = "repo",
): WorkflowJobRecord => ({
  jobId,
  repositoryId,
  organizationId: "org",
  submitterUserId: "author",
  repositoryCanonicalKey: null,
  status,
  revision: 0,
  leaseUntil: null,
  pendingControl: null,
  checkedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  record: {
    jobId,
    repositoryId,
    workflowId: "workflow",
    environmentId: EnvironmentId.make("environment"),
    instruction: "x".repeat(2000),
    status,
    detail: null,
    workflow: null,
    progress: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
});
describe.skipIf(!url)("workflow run pages (PostgreSQL)", () => {
  it.effect(
    "backfills bounded summaries, keeps old waits discoverable, and seeks through tied timestamps",
    () =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const fs = yield* FileSystem.FileSystem;
        const initial = yield* fs.readFileString(
          new URL(
            "../../migrations/postgres/20261008114100_repository_workflows/migration.sql",
            import.meta.url,
          ).pathname,
        );
        const migration = yield* fs.readFileString(
          new URL(
            "../../migrations/postgres/20261015110011_workflow_job_pages/migration.sql",
            import.meta.url,
          ).pathname,
        );
        const result = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              for (const statement of initial.split("--> statement-breakpoint"))
                yield* sql.unsafe(statement.replace("CREATE TABLE", "CREATE TEMP TABLE"));
              const store = yield* make;
              // A legacy row exists before adding the generated projection.
              const waiting = job("000-old-wait", "awaiting_review");
              yield* store.createJob(waiting);
              for (const statement of migration.split("--> statement-breakpoint"))
                yield* sql.unsafe(statement);
              const originMigration = yield* fs.readFileString(
                new URL(
                  "../../migrations/postgres/20261015151148_workflow_origin/migration.sql",
                  import.meta.url,
                ).pathname,
              );
              for (const statement of originMigration.split("--> statement-breakpoint"))
                yield* sql.unsafe(statement);
              const eventsMigration = yield* fs.readFileString(
                new URL(
                  "../../migrations/postgres/20261016074602_workflow_events/migration.sql",
                  import.meta.url,
                ).pathname,
              );
              // This legacy fixture has no native source tables; the source suite runs the full migration.
              for (const statement of eventsMigration.split("--> statement-breakpoint"))
                if (
                  statement.trim() &&
                  !/ALTER TABLE "relay_workflow_(connections|authorizations)"/.test(statement)
                )
                  yield* sql.unsafe(statement);

              expect((yield* store.getJob(waiting.jobId))?.record.origin).toEqual({
                kind: "manual",
                userId: "author",
              });
              for (let n = 0; n < 151; n++)
                yield* store.createJob(job(`done-${String(n).padStart(3, "0")}`, "done"));
              for (let n = 0; n < 122; n++)
                yield* store.createJob(job(`run-${String(n).padStart(3, "0")}`));
              yield* store.createJob(job("foreign", "awaiting_review", "other-repo"));
              yield* store.save("org", "repo", {
                workflowId: "workflow",
                expectedRevision: 0,
                archived: true,
                definition: {
                  name: "Archived workflow",
                  environmentId: EnvironmentId.make("environment"),
                  projectId: ProjectId.make("project"),
                  steps: [
                    {
                      id: "agent",
                      kind: "agent",
                      title: "Implement",
                      instruction: "Implement",
                      modelSelection: null,
                    },
                  ],
                },
              });
              const attention = yield* store.pageJobs("repo", { view: "attention" });
              expect(attention.jobs.map((j) => j.jobId)).toEqual([waiting.jobId]);
              expect(attention.jobs[0]!.instruction).toHaveLength(500);
              expect(isJobSummary(attention.jobs[0])).toBe(true);
              expect(attention.jobs[0]).not.toHaveProperty("workflow");
              expect(attention.jobs[0]).not.toHaveProperty("progress");
              const ids: string[] = [];
              let cursor: string | null = null;
              do {
                const page: WorkflowJobPage = yield* store.pageJobs("repo", {
                  view: "active",
                  limit: 50,
                  ...(cursor ? { cursor } : {}),
                });
                expect(page.jobs.length).toBeLessThanOrEqual(50);
                ids.push(...page.jobs.map((j) => j.jobId));
                cursor = page.nextCursor;
              } while (cursor);
              expect(ids).toHaveLength(123);
              expect(new Set(ids).size).toBe(123);
              expect(ids[0]).toBe(waiting.jobId);
              const history = yield* store.pageJobs("repo", { view: "history", limit: 100 });
              expect(history.jobs).toHaveLength(100);
              expect(history.jobs[0]!.jobId).toBe("done-150");
              const older = yield* store.pageJobs("repo", {
                view: "history",
                cursor: history.nextCursor!,
              });
              expect(older.jobs).toHaveLength(50);
              const last = yield* store.pageJobs("repo", {
                view: "history",
                cursor: older.nextCursor!,
              });
              expect(last.jobs.map((j) => j.jobId)).toEqual(["done-000"]);
              expect(last.nextCursor).toBeNull();
              for (const [repositoryId, view] of [
                ["other-repo", "history"],
                ["repo", "active"],
              ] as const) {
                expect(
                  yield* store
                    .pageJobs(repositoryId, { view, cursor: history.nextCursor! })
                    .pipe(Effect.flip),
                ).toBeInstanceOf(WorkflowInvalidError);
              }
              expect(
                yield* store
                  .pageJobs("repo", { view: "active", cursor: "malformed" })
                  .pipe(Effect.flip),
              ).toBeInstanceOf(WorkflowInvalidError);
              const complete = {
                ...waiting.record,
                status: "done" as const,
                updatedAt: "2026-02-01T00:00:00.000Z",
              };
              yield* store.updateJob(waiting, complete);
              expect((yield* store.pageJobs("repo", { view: "attention" })).jobs).toEqual([]);
              const saved = (yield* store.pageJobs("repo", { view: "history", limit: 100 })).jobs;
              // Same createdAt means this old job appears on a later history page, not sorted by updatedAt.
              expect(saved.some((j) => j.jobId === waiting.jobId)).toBe(false);
              const [projection] = yield* sql<{
                summary: { status: string; updatedAt: string };
              }>`SELECT summary FROM relay_workflow_jobs WHERE job_id = ${waiting.jobId}`;
              expect(projection!.summary.status).toBe("done");
              expect(projection!.summary.updatedAt).toBe(complete.updatedAt);
              expect(yield* store.listJobs("repo")).toHaveLength(100);
              const blocked = job("blocked", "queued");
              blocked.record = { ...blocked.record, detail: "Restore the archived workflow." };
              const cancelling = job("cancellation-failed", "cancelling");
              cancelling.record = {
                ...cancelling.record,
                progress: {
                  revision: 1,
                  status: "cancelling",
                  threadId: ThreadId.make("thread"),
                  detail: "Cleanup failed",
                  checkpoint: null,
                  retryableCancellation: true,
                },
              };
              yield* store.createJob(blocked);
              yield* store.createJob(cancelling);
              yield* store.createJob(job("queued-without-block", "queued"));
              yield* store.createJob(job("cancellation-in-progress", "cancelling"));
              yield* store.createJob(job("paused", "paused"));
              yield* store.createJob(job("input", "awaiting_input"));
              expect(
                (yield* store.pageJobs("repo", { view: "attention" })).jobs.map((j) => j.jobId),
              ).toEqual(["blocked", "cancellation-failed", "input", "paused"]);
              expect(
                yield* store
                  .pageJobs("repo", {
                    view: "active",
                    cursor:
                      '{"version":2,"repositoryId":"repo","view":"active","createdAt":"2026-01-01","jobId":"any"}',
                  })
                  .pipe(Effect.flip),
              ).toBeInstanceOf(WorkflowInvalidError);

              return yield* Effect.fail("rollback-pages" as const);
            }),
          )
          .pipe(Effect.flip);
        expect(result).toBe("rollback-pages");
      }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
