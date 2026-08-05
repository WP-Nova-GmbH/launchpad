import type { RelayJob, RelayJobId, RelayJobStatus } from "@t3tools/contracts/relay";
import { eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { relayJobs } from "../persistence/schema.ts";

/**
 * A job together with the owner the relay authorizes reads against. The owner
 * never leaves the relay: handlers answer with `toRelayJob(record)`.
 */
export interface RelayJobRecord extends RelayJob {
  readonly ownerUserId: string;
}

export class JobPersistenceError extends Schema.TaggedErrorClass<JobPersistenceError>()(
  "JobPersistenceError",
  {
    operation: Schema.Literals(["create-job", "load-job", "update-status"]),
    jobId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Job '${this.operation}' failed for job '${this.jobId}'`;
  }
}

export function toRelayJob(record: RelayJobRecord): RelayJob {
  return {
    jobId: record.jobId,
    status: record.status,
    environmentId: record.environmentId,
    repositoryCanonicalKey: record.repositoryCanonicalKey,
    baseBranch: record.baseBranch,
    threadId: record.threadId,
    detail: record.detail,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

const jobColumns = {
  jobId: relayJobs.jobId,
  ownerUserId: relayJobs.ownerUserId,
  status: relayJobs.status,
  environmentId: relayJobs.environmentId,
  repositoryCanonicalKey: relayJobs.repositoryCanonicalKey,
  baseBranch: relayJobs.baseBranch,
  threadId: relayJobs.threadId,
  detail: relayJobs.detail,
  createdAt: relayJobs.createdAt,
  updatedAt: relayJobs.updatedAt,
};

interface JobRow {
  readonly jobId: string;
  readonly ownerUserId: string;
  readonly status: RelayJobStatus;
  readonly environmentId: string;
  readonly repositoryCanonicalKey: string;
  readonly baseBranch: string;
  readonly threadId: string | null;
  readonly detail: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function toRecord(row: JobRow): RelayJobRecord {
  return {
    jobId: row.jobId as RelayJob["jobId"],
    ownerUserId: row.ownerUserId,
    status: row.status,
    environmentId: row.environmentId as RelayJob["environmentId"],
    repositoryCanonicalKey: row.repositoryCanonicalKey,
    baseBranch: row.baseBranch,
    threadId: row.threadId as RelayJob["threadId"],
    detail: row.detail,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class Jobs extends Context.Service<
  Jobs,
  {
    readonly create: (input: {
      readonly jobId: RelayJobId;
      readonly ownerUserId: string;
      readonly environmentId: RelayJob["environmentId"];
      readonly repositoryCanonicalKey: string;
      readonly baseBranch: string;
      readonly instruction: string;
    }) => Effect.Effect<RelayJobRecord, JobPersistenceError>;
    readonly getById: (input: {
      readonly jobId: RelayJobId;
    }) => Effect.Effect<RelayJobRecord | null, JobPersistenceError>;
    readonly updateStatus: (input: {
      readonly jobId: RelayJobId;
      readonly status: RelayJobStatus;
      readonly detail: string | null;
    }) => Effect.Effect<RelayJobRecord | null, JobPersistenceError>;
  }
>()("t3code-relay/jobs/Jobs") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return Jobs.of({
    create: Effect.fn("relay.jobs.create")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
        "relay.job_id": input.jobId,
      });
      const now = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* db
        .insert(relayJobs)
        .values({
          jobId: input.jobId,
          environmentId: input.environmentId,
          ownerUserId: input.ownerUserId,
          repositoryCanonicalKey: input.repositoryCanonicalKey,
          baseBranch: input.baseBranch,
          instruction: input.instruction,
          status: "queued",
          threadId: null,
          detail: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(jobColumns)
        .pipe(
          Effect.mapError(
            (cause) =>
              new JobPersistenceError({
                operation: "create-job",
                jobId: input.jobId,
                cause,
              }),
          ),
        );
      const row = rows[0];
      if (!row) {
        return yield* new JobPersistenceError({
          operation: "create-job",
          jobId: input.jobId,
          cause: "insert returned no row",
        });
      }
      return toRecord(row);
    }),

    getById: Effect.fn("relay.jobs.get_by_id")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.job_id": input.jobId });
      const rows = yield* db
        .select(jobColumns)
        .from(relayJobs)
        .where(eq(relayJobs.jobId, input.jobId))
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) =>
              new JobPersistenceError({
                operation: "load-job",
                jobId: input.jobId,
                cause,
              }),
          ),
        );
      const row = rows[0];
      return row ? toRecord(row) : null;
    }),

    updateStatus: Effect.fn("relay.jobs.update_status")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.job_id": input.jobId,
        "relay.job.status": input.status,
      });
      const rows = yield* db
        .update(relayJobs)
        .set({
          status: input.status,
          detail: input.detail,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .where(eq(relayJobs.jobId, input.jobId))
        .returning(jobColumns)
        .pipe(
          Effect.mapError(
            (cause) =>
              new JobPersistenceError({
                operation: "update-status",
                jobId: input.jobId,
                cause,
              }),
          ),
        );
      const row = rows[0];
      return row ? toRecord(row) : null;
    }),
  });
});

export const layer = Layer.effect(Jobs, make);
