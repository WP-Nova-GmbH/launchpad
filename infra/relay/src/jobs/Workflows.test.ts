import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { WorkflowConflictError, type RepositoryWorkflow } from "@t3tools/contracts/workflows";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { RelayDb } from "../db.ts";
import { make, type WorkflowJobRecord } from "./Workflows.ts";

const NOW = "2026-10-08T12:00:00.000Z";
const workflow: RepositoryWorkflow = {
  workflowId: "flow-1",
  organizationId: "org-1",
  repositoryId: "repo-1",
  revision: 1,
  archived: false,
  createdAt: NOW,
  updatedAt: NOW,
  definition: {
    name: "Implement",
    environmentId: EnvironmentId.make("env-1"),
    projectId: ProjectId.make("project-1"),
    steps: [
      {
        id: "agent",
        kind: "agent",
        title: "Agent",
        instruction: "Implement",
        modelSelection: null,
      },
      { id: "review", kind: "review", title: "Review", role: "maintainer" },
    ],
  },
};

it.effect("retains a workflow on stale edits and allows exactly one concurrent revision", () =>
  Effect.gen(function* () {
    let saved = { revision: 1, record: workflow };
    const dialect = new PgDialect();
    const db = {
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Effect.sync(() => [saved]) }) }),
      }),
      update: () => ({
        set: (next: typeof saved) => ({
          where: (condition: SQL) => ({
            returning: () =>
              Effect.sync(() => {
                const [, revision] = dialect.sqlToQuery(condition).params;
                if (revision !== saved.revision) return [];
                saved = next;
                return [saved];
              }),
          }),
        }),
      }),
    } as unknown as RelayDb["Service"];
    const store = yield* make.pipe(Effect.provide(Layer.succeed(RelayDb, db)));
    const input = {
      workflowId: workflow.workflowId,
      expectedRevision: 1,
      definition: workflow.definition,
      archived: false,
    };
    const outcomes = yield* Effect.forEach(
      ["First edit", "Second edit"],
      (name) =>
        store
          .save("org-1", "repo-1", { ...input, definition: { ...input.definition, name } })
          .pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    assert.strictEqual(outcomes.filter(Result.isSuccess).length, 1);
    assert.strictEqual(outcomes.filter(Result.isFailure).length, 1);
    assert.strictEqual(saved.revision, 2);
    assert.instanceOf(
      yield* Effect.flip(store.save("org-1", "repo-1", input)),
      WorkflowConflictError,
    );
    assert.instanceOf(
      yield* Effect.flip(store.save("org-1", "another-repo", { ...input, expectedRevision: 2 })),
      WorkflowConflictError,
    );
    assert.strictEqual(saved.record.repositoryId, "repo-1");
  }),
);

it.effect("prevents late acceptance from replacing a saved cancellation", () =>
  Effect.gen(function* () {
    let saved: WorkflowJobRecord = {
      jobId: "job-1",
      repositoryId: "repo-1",
      organizationId: "org-1",
      submitterUserId: "user-1",
      repositoryCanonicalKey: "github.com/acme/repo",
      status: "dispatching",
      revision: 2,
      leaseUntil: NOW,
      pendingControl: null,
      createdAt: NOW,
      checkedAt: NOW,
      record: {
        jobId: "job-1",
        repositoryId: "repo-1",
        workflowId: workflow.workflowId,
        environmentId: workflow.definition.environmentId,
        instruction: "Fix issue",
        status: "dispatching",
        detail: null,
        workflow,
        progress: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    };
    const dialect = new PgDialect();
    const db = {
      update: () => ({
        set: (next: Partial<WorkflowJobRecord>) => ({
          where: (condition: SQL) => ({
            returning: () =>
              Effect.sync(() => {
                const [jobId, revision] = dialect.sqlToQuery(condition).params;
                if (jobId !== saved.jobId || revision !== saved.revision) return [];
                saved = { ...saved, ...next };
                return [saved];
              }),
          }),
        }),
      }),
    } as unknown as RelayDb["Service"];
    const store = yield* make.pipe(Effect.provideService(RelayDb, db));
    const offered = saved;
    const cancelling = yield* store.updateJob(
      offered,
      { ...offered.record, status: "cancelling" },
      {
        userId: "maintainer",
        response: { operation: "cancel" },
      },
    );
    assert.instanceOf(
      yield* Effect.flip(
        store.updateJob(offered, { ...offered.record, status: "preparing" }, null),
      ),
      WorkflowConflictError,
    );
    assert.strictEqual(saved.status, "cancelling");
    assert.strictEqual(saved.pendingControl?.response.operation, "cancel");
    const cancelled = yield* store.updateJob(
      cancelling,
      { ...cancelling.record, status: "cancelled" },
      null,
    );
    assert.instanceOf(
      yield* Effect.flip(
        store.updateJob(cancelling, { ...cancelling.record, status: "running" }, null),
      ),
      WorkflowConflictError,
    );
    assert.deepStrictEqual(
      yield* store.updateJob(cancelled, { ...cancelled.record, status: "running" }, null),
      cancelled,
    );
    assert.strictEqual(saved.status, "cancelled");
    assert.isNull(saved.pendingControl);
  }),
);
