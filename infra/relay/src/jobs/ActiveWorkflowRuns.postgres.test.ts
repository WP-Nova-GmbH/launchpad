import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ActiveWorkflowRunPage, WorkflowInvalidError } from "@t3tools/contracts/workflows";
import * as Schema from "effect/Schema";
import { RelayDb } from "../db.ts";
import { databaseUrl, withDatabase } from "../workflowSources/test-fixture.ts";
import { pageActiveWorkflowRuns } from "./ActiveWorkflowRuns.ts";
import { make as makeWorkflows } from "./Workflows.ts";

const isRunPage = Schema.is(ActiveWorkflowRunPage);

describe.skipIf(!databaseUrl)("organization active workflow runs (PostgreSQL)", () => {
  it.live(
    "pages unfinished runs across visible repositories and resolves titles before and after preparation",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const db = yield* RelayDb;
          const sql = db.$client;
          yield* sql`INSERT INTO relay_repository_workflows (workflow_id,repository_id,revision,record)
          VALUES ('wf','repo',1,'{"definition":{"name":"Implement issues"}}')`;
          // Tied creation times exercise the shared oldest-first order across repositories.
          yield* sql`INSERT INTO relay_workflow_jobs
          (job_id,repository_id,organization_id,submitter_user_id,status,record,revision,created_at,checked_at)
          SELECT id,repo,org,'owner',status,record::jsonb,0,'2026-11-20','2026-11-20' FROM (VALUES
            ('a','repo','org','queued','{"workflowId":"wf","event":{"identifier":"WP-331","title":"Issue at trigger"}}'),
            ('b','repo-2','org','awaiting_review','{"workflow":{"definition":{"name":"Review updates"}}}'),
            ('c','repo','org','paused','{"workflowId":"wf","instruction":"private prompt"}'),
            ('d','repo','org','done','{}'), ('e','repo','org','cancelled','{}'), ('f','repo','org','failed','{}'),
            ('g','foreign','other-org','running','{}')
          ) AS fixtures(id,repo,org,status,record)`;
          const first = yield* pageActiveWorkflowRuns(db, "admin", { limit: 2 });
          expect(first).toMatchObject({
            organizationId: "org",
            total: 3,
            jobs: [
              {
                jobId: "a",
                title: "Issue at trigger",
                issueIdentifier: "WP-331",
                repositoryName: "Repository",
                status: "queued",
              },
              {
                jobId: "b",
                title: "Review updates",
                issueIdentifier: null,
                repositoryId: "repo-2",
                status: "awaiting_review",
              },
            ],
          });
          const cursor = first.nextCursor!;
          const next = yield* pageActiveWorkflowRuns(db, "admin", { cursor, limit: 2 });
          expect(next).toMatchObject({
            total: 3,
            nextCursor: null,
            jobs: [{ jobId: "c", title: "Implement issues" }],
          });
          expect(next.jobs[0]).not.toHaveProperty("instruction");
          yield* sql`UPDATE relay_workflow_jobs SET record=record || '{"issueSnapshot":{"title":"Captured title","identifier":"WP-332"}}'::jsonb WHERE job_id='a'`;
          const member = yield* pageActiveWorkflowRuns(db, "reader", {});
          expect(member).toMatchObject({
            organizationId: "org",
            total: 2,
            jobs: [
              { jobId: "a", title: "Captured title", issueIdentifier: "WP-332" },
              { jobId: "c" },
            ],
          });
          expect(
            (yield* pageActiveWorkflowRuns(db, "outsider", {})).jobs.map((r) => r.jobId),
          ).toEqual(["g"]);
          expect(yield* pageActiveWorkflowRuns(db, "new-user", {})).toEqual({
            organizationId: null,
            jobs: [],
            total: 0,
            nextCursor: null,
          });
          // A cursor from an exhausted or changed dataset still reports the full current total.
          yield* sql`UPDATE relay_workflow_jobs SET status='done' WHERE job_id='c'`;
          expect(yield* pageActiveWorkflowRuns(db, "admin", { cursor })).toEqual({
            organizationId: "org",
            jobs: [],
            total: 2,
            nextCursor: null,
          });
          expect(
            yield* pageActiveWorkflowRuns(db, "reader", { cursor }).pipe(Effect.flip),
          ).toBeInstanceOf(WorkflowInvalidError);
          expect(
            yield* pageActiveWorkflowRuns(db, "admin", { cursor: "bad" }).pipe(Effect.flip),
          ).toBeInstanceOf(WorkflowInvalidError);
          yield* sql`DELETE FROM relay_repository_access WHERE user_id='reader'`;
          expect((yield* pageActiveWorkflowRuns(db, "reader", {})).total).toBe(0);
          yield* sql`UPDATE relay_organization_members SET organization_id='other-org' WHERE user_id='admin'`;
          expect(
            yield* pageActiveWorkflowRuns(db, "admin", { cursor }).pipe(Effect.flip),
          ).toBeInstanceOf(WorkflowInvalidError);
        }),
      ),
  );
  it.live("projects actionable queue blockers and manual holds in both run lists", () =>
    withDatabase(
      Effect.gen(function* () {
        const db = yield* RelayDb;
        const sql = db.$client;
        yield* sql`INSERT INTO relay_workflow_jobs
            (job_id,repository_id,organization_id,submitter_user_id,status,record,pending_control,revision,created_at,checked_at)
            SELECT id,'repo','org','owner',status,record::jsonb,control::jsonb,0,'2026-11-20','2026-11-20' FROM (VALUES
              ('a','queued','{"queueReason":{"code":"vm_waiting_capacity","retryAt":123}}',NULL),
              ('b','queued','{"queueReason":{"code":"vm_limit_disabled","retryAt":null}}',NULL),
              ('c','preparing','{"queueReason":{"code":"source_reconnect","retryAt":null}}',NULL),
              ('d','queued','{"queueReason":{"code":"environment_offline","retryAt":null}}',NULL),
              ('e','queued','{"detail":"private legacy blocker"}',NULL),
              ('f','awaiting_review','{"pendingManualControl":{"operation":"pause","controlId":"private control"}}',
                '{"response":{"operation":"pause","controlId":"private control"}}'),
              ('g','running','{"progress":{"manualPause":{"state":"requested"}}}',NULL),
              ('h','paused','{"progress":{"manualPause":{"state":"paused"}}}',NULL),
              ('i','paused','{"progress":{"manualPause":{"state":"paused"}}}','{"response":{"operation":"resume"}}'),
              ('j','cancelling','{"progress":{"manualPause":{"state":"requested"}}}',NULL)
            ) AS fixtures(id,status,record,control)`;
        const active = yield* pageActiveWorkflowRuns(db, "reader", {});
        expect(isRunPage(active)).toBe(true);
        const store = yield* makeWorkflows;
        const repository = yield* store.pageJobs("repo", { view: "active" });
        for (const page of [active, repository]) {
          expect(
            page.jobs.map((row) => [
              row.queueReason?.code ?? null,
              row.needsAttention ?? false,
              row.manualPauseState ?? null,
            ]),
          ).toEqual([
            ["vm_waiting_capacity", false, null],
            ["vm_limit_disabled", true, null],
            ["source_reconnect", true, null],
            ["environment_offline", false, null],
            [null, true, null],
            [null, true, "pause_requested"],
            [null, false, "pause_requested"],
            [null, true, "paused"],
            [null, true, "resume_requested"],
            [null, false, null],
          ]);
        }
        expect(active.jobs[0]?.queueReason).toEqual({ code: "vm_waiting_capacity" });
        expect(JSON.stringify(active)).not.toContain("private");
        expect(JSON.stringify(repository)).not.toContain("private control");
      }),
    ),
  );
  it.live("shows a cancellation blocker until the relay accepts a retry", () =>
    withDatabase(
      Effect.gen(function* () {
        const db = yield* RelayDb;
        const sql = db.$client;
        const store = yield* makeWorkflows;
        yield* sql`INSERT INTO relay_workflow_jobs
        (job_id,repository_id,organization_id,submitter_user_id,status,record,revision,created_at,checked_at)
        VALUES ('cleanup','repo','org','owner','cancelling',
          '{"progress":{"status":"cancelling","retryableCancellation":true}}',0,'2026-11-20','2026-11-20')`;
        for (const cancellationState of ["retry_needed", "pending"] as const) {
          if (cancellationState === "pending") {
            yield* sql`UPDATE relay_workflow_jobs SET pending_control =
            '{"userId":"private-user","response":{"operation":"retry_cancellation","expectedRevision":1}}'
            WHERE job_id='cleanup'`;
          }
          const shelf = yield* pageActiveWorkflowRuns(db, "reader", {});
          const attention = yield* store.pageJobs("repo", { view: "attention" });
          for (const page of [shelf, attention]) {
            expect(page.jobs).toMatchObject([{ jobId: "cleanup", cancellationState }]);
            expect(JSON.stringify(page)).not.toContain("private-user");
          }
        }
        yield* sql`UPDATE relay_workflow_jobs SET status='cancelled' WHERE job_id='cleanup'`;
        const history = yield* store.pageJobs("repo", { view: "history" });
        expect(history.jobs[0]?.cancellationState).toBeUndefined();
      }),
    ),
  );
  it.live(
    "distinguishes an open checkpoint from an accepted response, a save failure, and a finishing run",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const db = yield* RelayDb;
          const sql = db.$client;
          yield* sql`INSERT INTO relay_workflow_jobs
        (job_id,repository_id,organization_id,submitter_user_id,status,record,pending_control,revision,created_at,checked_at)
        SELECT id,'repo','org','owner',status,record::jsonb,control::jsonb,0,'2026-11-20','2026-11-20' FROM (VALUES
          ('a','awaiting_review','{}',NULL),
          ('b','awaiting_review','{}','{"response":{"operation":"approve"}}'),
          ('c','awaiting_input','{}','{"response":{"operation":"input"}}'),
          ('d','awaiting_review','{"progress":{"approvalPending":true}}',NULL),
          ('e','awaiting_review','{"progress":{"resultSaving":{"state":"saving"}}}',NULL),
          ('f','awaiting_review','{"progress":{"resultSaving":{"state":"failed","detail":"private diagnostic"}}}',NULL),
          ('g','awaiting_input','{"progress":{"resultSaving":{"state":"failed","publicationId":"p"}}}','{"response":{"operation":"retry_saving","publicationId":"p"}}'),
          ('h','awaiting_review','{"workflow":{"definition":{"steps":[{"id":"review"}]}},"progress":{"steps":[{"stepId":"review","generation":0,"status":"completed"}]}}',NULL),
          ('i','finishing','{"progress":{"retryableApproval":true,"detail":"private diagnostic"}}',NULL)
        ) AS fixtures(id,status,record,control)`;
          const page = yield* pageActiveWorkflowRuns(db, "reader", {});
          expect(isRunPage(page)).toBe(true);
          expect(
            page.jobs.map((job) => [
              job.jobId,
              job.checkpointResponsePending ?? false,
              job.completionState ?? null,
            ]),
          ).toEqual([
            ["a", false, null],
            ["b", true, null],
            ["c", true, null],
            ["d", true, null],
            ["e", false, "saving_result"],
            ["f", false, "save_failed"],
            ["g", false, "retrying_save"],
            ["h", false, "finishing"],
            ["i", false, "completion_blocked"],
          ]);
          for (const row of page.jobs) expect(Object.keys(row)).not.toContain("finalChecks");
          expect(JSON.stringify(page)).not.toContain("private diagnostic");
        }),
      ),
  );
});
