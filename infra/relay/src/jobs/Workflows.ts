import {
  RepositoryWorkflow,
  RepositoryWorkflowJob,
  isTerminalWorkflowJob,
  WorkflowConflictError,
  WorkflowInvalidError,
  type WorkflowJobPageQuery,
  type WorkflowJobPage,
  type SaveRepositoryWorkflow,
} from "@t3tools/contracts/workflows";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { RelayDb } from "../db.ts";
import { relayRepositoryWorkflows, relayWorkflowJobs } from "../persistence/schema.ts";

export type WorkflowJobRecord = Omit<typeof relayWorkflowJobs.$inferSelect, "summary">;
const JobPageCursor = Schema.Struct({
  version: Schema.Literal(1),
  repositoryId: Schema.String,
  view: Schema.Literals(["active", "attention", "history"]),
  createdAt: Schema.String.check(Schema.isMaxLength(64)),
  jobId: Schema.String.check(Schema.isMaxLength(64)),
});
const decodeCursor = Schema.decodeEffect(Schema.fromJsonString(JobPageCursor));
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(JobPageCursor));
export class WorkflowPersistenceError extends Schema.TaggedError<WorkflowPersistenceError>()(
  "WorkflowPersistenceError",
  { cause: Schema.Defect() },
) {}
const persist = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => new WorkflowPersistenceError({ cause })));

export const make = Effect.gen(function* () {
  const db = yield* RelayDb;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const get = (workflowId: string) =>
    persist(
      db
        .select()
        .from(relayRepositoryWorkflows)
        .where(eq(relayRepositoryWorkflows.workflowId, workflowId))
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0]?.record ?? null));
  const getJob = (jobId: string) =>
    persist(
      db.select().from(relayWorkflowJobs).where(eq(relayWorkflowJobs.jobId, jobId)).limit(1),
    ).pipe(Effect.map((rows): WorkflowJobRecord | null => rows[0] ?? null));
  return {
    get,
    getJob,
    list: (repositoryId: string) =>
      persist(
        db
          .select()
          .from(relayRepositoryWorkflows)
          .where(eq(relayRepositoryWorkflows.repositoryId, repositoryId)),
      ).pipe(Effect.map((rows) => rows.map((row) => row.record))),
    save: Effect.fn("Workflows.save")(function* (
      organizationId: string,
      repositoryId: string,
      input: typeof SaveRepositoryWorkflow.Type,
    ) {
      const timestamp = yield* now;
      const previous = yield* get(input.workflowId);
      if (
        (previous && previous.repositoryId !== repositoryId) ||
        (previous?.revision ?? 0) !== input.expectedRevision
      ) {
        return yield* new WorkflowConflictError({
          message: "This workflow changed. Reload it before saving; your draft has been retained.",
        });
      }
      const record = {
        workflowId: input.workflowId,
        organizationId,
        repositoryId,
        revision: input.expectedRevision + 1,
        definition: input.definition,
        archived: input.archived,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
      } satisfies RepositoryWorkflow;
      const rows = previous
        ? yield* persist(
            db
              .update(relayRepositoryWorkflows)
              .set({ revision: record.revision, record })
              .where(
                and(
                  eq(relayRepositoryWorkflows.workflowId, input.workflowId),
                  eq(relayRepositoryWorkflows.revision, input.expectedRevision),
                ),
              )
              .returning(),
          )
        : yield* persist(
            db
              .insert(relayRepositoryWorkflows)
              .values({
                workflowId: input.workflowId,
                repositoryId,
                revision: record.revision,
                record,
              })
              .onConflictDoNothing()
              .returning(),
          );
      if (rows.length === 0)
        return yield* new WorkflowConflictError({
          message: "This workflow was saved elsewhere. Reload before saving your draft.",
        });
      return record;
    }),
    createJob: (row: WorkflowJobRecord) =>
      persist(db.insert(relayWorkflowJobs).values(row)).pipe(Effect.as(row)),
    listJobs: (repositoryId: string) =>
      persist(
        db
          .select()
          .from(relayWorkflowJobs)
          .where(eq(relayWorkflowJobs.repositoryId, repositoryId))
          .orderBy(desc(relayWorkflowJobs.createdAt))
          .limit(100),
      ),
    pageJobs: Effect.fn("Workflows.pageJobs")(function* (
      repositoryId: string,
      query: WorkflowJobPageQuery,
    ): Effect.fn.Return<WorkflowJobPage, WorkflowPersistenceError | WorkflowInvalidError> {
      const cursor =
        query.cursor === undefined
          ? null
          : yield* decodeCursor(query.cursor).pipe(
              Effect.mapError(
                () =>
                  new WorkflowInvalidError({
                    message: "Invalid run-list cursor. Refresh the list.",
                  }),
              ),
            );
      if (cursor && (cursor.repositoryId !== repositoryId || cursor.view !== query.view))
        return yield* new WorkflowInvalidError({
          message: "This cursor belongs to a different run list. Refresh the list.",
        });
      const jobs = relayWorkflowJobs;
      const history = query.view === "history";
      const limit = query.limit ?? 50;
      const rows = yield* persist(
        db
          .select({ summary: jobs.summary })
          .from(jobs)
          .where(
            and(
              eq(jobs.repositoryId, repositoryId),
              history
                ? sql`${jobs.status} IN ('done','cancelled','failed')`
                : sql`${jobs.status} NOT IN ('done','cancelled','failed')`,
              query.view === "attention"
                ? sql`${jobs.summary}->>'needsAttention' = 'true'`
                : undefined,
              cursor
                ? history
                  ? sql`(${jobs.createdAt}, ${jobs.jobId}) < (${cursor.createdAt}, ${cursor.jobId})`
                  : sql`(${jobs.createdAt}, ${jobs.jobId}) > (${cursor.createdAt}, ${cursor.jobId})`
                : undefined,
            ),
          )
          .orderBy(
            history ? desc(jobs.createdAt) : asc(jobs.createdAt),
            history ? desc(jobs.jobId) : asc(jobs.jobId),
          )
          .limit(limit + 1),
      );
      const page = rows.slice(0, limit).map((row) => row.summary);
      const last = page.at(-1);
      return {
        jobs: page,
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({
                version: 1,
                repositoryId,
                view: query.view,
                createdAt: last.createdAt,
                jobId: last.jobId,
              })
            : null,
      };
    }),
    pendingJobs: () =>
      persist(
        db
          .select()
          .from(relayWorkflowJobs)
          .where(
            inArray(relayWorkflowJobs.status, [
              "queued",
              "dispatching",
              "preparing",
              "running",
              "awaiting_review",
              "awaiting_input",
              "waiting_capacity",
              "finishing",
              "paused",
              "cancelling",
            ]),
          )
          .orderBy(asc(relayWorkflowJobs.checkedAt), asc(relayWorkflowJobs.createdAt))
          .limit(100),
      ),
    /** A cross-instance lease pins an offered snapshot until acceptance is reconciled. */
    claim: Effect.fn("Workflows.claim")(function* (jobId: string) {
      const timestamp = yield* now;
      const leaseUntil = DateTime.formatIso(DateTime.add(yield* DateTime.now, { seconds: 30 }));
      const rows = yield* persist(
        db
          .update(relayWorkflowJobs)
          .set({ leaseUntil, checkedAt: timestamp })
          .where(
            and(
              eq(relayWorkflowJobs.jobId, jobId),
              or(
                isNull(relayWorkflowJobs.leaseUntil),
                lte(relayWorkflowJobs.leaseUntil, timestamp),
              ),
            ),
          )
          .returning(),
      );
      const row: WorkflowJobRecord | null = rows[0] ?? null;
      return row;
    }),
    updateJob: Effect.fn("Workflows.updateJob")(function* (
      previous: WorkflowJobRecord,
      record: RepositoryWorkflowJob,
      pendingControl = previous.pendingControl,
      releaseLease = true,
    ) {
      if (isTerminalWorkflowJob(previous.record.status)) return previous;
      const rows = yield* persist(
        db
          .update(relayWorkflowJobs)
          .set({
            record,
            status: record.status,
            repositoryCanonicalKey: previous.repositoryCanonicalKey,
            pendingControl,
            revision: previous.revision + 1,
            ...(releaseLease ? { leaseUntil: null } : {}),
          })
          .where(
            and(
              eq(relayWorkflowJobs.jobId, previous.jobId),
              eq(relayWorkflowJobs.revision, previous.revision),
            ),
          )
          .returning(),
      );
      if (rows.length === 0)
        return yield* new WorkflowConflictError({
          message: "The job changed. Refresh its current state.",
        });
      const row: WorkflowJobRecord = rows[0]!;
      return row;
    }),
    release: (jobId: string, leaseUntil: string) =>
      persist(
        db
          .update(relayWorkflowJobs)
          .set({ leaseUntil: null })
          .where(
            and(eq(relayWorkflowJobs.jobId, jobId), eq(relayWorkflowJobs.leaseUntil, leaseUntil)),
          ),
      ).pipe(Effect.asVoid),
  };
});
export class Workflows extends Context.Service<Workflows, Effect.Success<typeof make>>()(
  "launchpad-relay/jobs/Workflows",
) {}
export const layer = Layer.effect(Workflows, make);
