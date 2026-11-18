import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { RelayDb } from "../db.ts";
import { databaseUrl, withDatabase } from "../workflowSources/test-fixture.ts";
import {
  claimWorkflowVmPublishCommand,
  readWorkflowVmPublishCommands,
  stopWorkflowVmPublishCommand,
} from "./WorkflowVmPublishing.ts";

if (!databaseUrl)
  throw new Error("VM publishing ledger tests require WORKFLOW_SOURCES_TEST_DATABASE_URL.");

const binding = {
  jobId: "job",
  organizationId: "org",
  repositoryId: "repo",
  threadId: ThreadId.make("workflow:job"),
  environmentId: EnvironmentId.make("vm-environment"),
  projectId: ProjectId.make("vm:workflow:job"),
  allocationId: "allocation",
  generation: 1,
  operationId: "provision",
};

const fixture = Effect.gen(function* () {
  const sql = (yield* RelayDb).$client;
  const fs = yield* FileSystem.FileSystem;
  const migration = yield* fs.readFileString(
    new URL(
      "../../migrations/postgres/20261118130000_workflow_vm_publishing/migration.sql",
      import.meta.url,
    ).pathname,
  );
  for (const statement of migration.split("--> statement-breakpoint"))
    if (statement.trim()) yield* sql.unsafe(statement);
  yield* sql`INSERT INTO relay_workflow_jobs
    (job_id,repository_id,organization_id,submitter_user_id,status,record,revision,created_at,checked_at)
    VALUES ('job','repo','org','maintainer','running',
      '{"origin":{"kind":"manual","userId":"maintainer"}}'::jsonb,0,'now','now')`;
  yield* sql`INSERT INTO relay_workflow_vm_publications (job_id,action_id,record)
    VALUES ('job','push','{}'::jsonb),('job','open-pr','{}'::jsonb)`;
  return sql;
});

const command = (commandId: string) => ({ commandId, pid: 42, identity: "captured" });

describe("workflow VM publishing command claims", () => {
  it.live("allows one concurrent writer and requires the owning generation's stop receipt", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* fixture;
        const results = yield* Effect.all(
          [
            claimWorkflowVmPublishCommand(sql, binding, "push", command("first")),
            claimWorkflowVmPublishCommand(sql, binding, "push", command("second")),
          ],
          { concurrency: 2 },
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        const owner = results[0] ? "first" : "second";
        const replacement = { ...binding, generation: 2, allocationId: "replacement" };
        yield* stopWorkflowVmPublishCommand(sql, replacement, "push", owner);
        expect(
          yield* claimWorkflowVmPublishCommand(sql, replacement, "open-pr", command("next")),
        ).toBe(false);
        yield* stopWorkflowVmPublishCommand(sql, binding, "push", owner);
        expect(
          yield* claimWorkflowVmPublishCommand(sql, replacement, "open-pr", command("next")),
        ).toBe(true);
        expect(yield* claimWorkflowVmPublishCommand(sql, binding, "push", command(owner))).toBe(
          false,
        );
        expect(yield* readWorkflowVmPublishCommands(sql, binding.jobId, "open-pr")).toMatchObject([
          { commandId: "next", generation: 2, stopped: false },
        ]);
      }),
    ),
  );

  it.live("keeps an earlier cancellation from arming a command", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* fixture;
        yield* sql`UPDATE relay_workflow_jobs SET pending_control='{"response":{"operation":"cancel"}}'
        WHERE job_id='job'`;
        expect(
          yield* claimWorkflowVmPublishCommand(sql, binding, "push", command("cancelled")),
        ).toBe(false);
        expect(yield* readWorkflowVmPublishCommands(sql, binding.jobId, "push")).toEqual([]);
      }),
    ),
  );

  it.live("fences a delayed arm after stop without recording a possible delivery", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* fixture;
        const delayed = command("delayed");
        yield* stopWorkflowVmPublishCommand(sql, binding, "open-pr", delayed.commandId);
        yield* stopWorkflowVmPublishCommand(sql, binding, "open-pr", delayed.commandId);
        expect(yield* claimWorkflowVmPublishCommand(sql, binding, "open-pr", delayed)).toBe(false);
        expect(yield* readWorkflowVmPublishCommands(sql, binding.jobId, "open-pr")).toEqual([]);

        const replacement = { ...binding, allocationId: "replacement", generation: 2 };
        expect(yield* claimWorkflowVmPublishCommand(sql, replacement, "open-pr", delayed)).toBe(
          true,
        );
        yield* stopWorkflowVmPublishCommand(sql, binding, "open-pr", delayed.commandId);
        expect(yield* readWorkflowVmPublishCommands(sql, binding.jobId, "open-pr")).toMatchObject([
          { commandId: delayed.commandId, generation: 2, stopped: false },
        ]);
      }),
    ),
  );
});
