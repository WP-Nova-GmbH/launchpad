import * as Schema from "effect/Schema";
import {
  RepositoryWorkflow,
  RepositoryWorkflowJob,
  WorkflowDefinition,
} from "@t3tools/contracts/workflows";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

export const LAUNCHPAD_JOB_BRANCH_PREFIX = "launchpad";

/** Use a stable branch name outside the auto-renamed t3code namespace. */
export function jobBranchName(
  jobId: string,
  prefix: "t3-job" | "launchpad-job" | typeof LAUNCHPAD_JOB_BRANCH_PREFIX = "t3-job",
): string {
  const sanitized = jobId.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${prefix}/${sanitized.length > 0 ? sanitized : "job"}`;
}

const LegacyDefinition = Schema.Struct({
  name: WorkflowDefinition.fields.name,
  steps: WorkflowDefinition.fields.steps,
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
const StoredWorkflow = Schema.Struct({
  ...RepositoryWorkflow.fields,
  definition: Schema.Union([WorkflowDefinition, LegacyDefinition]),
});
const readWorkflow = Schema.decodeUnknownSync(StoredWorkflow);

/** Storage codecs only: public and signed requests accept the current contracts. */
export function normalizeStoredWorkflow(value: unknown): RepositoryWorkflow {
  const workflow = readWorkflow(value);
  const definition = workflow.definition;
  return {
    ...workflow,
    definition:
      "target" in definition
        ? definition
        : {
            name: definition.name,
            steps: definition.steps,
            target: {
              kind: "machine",
              environmentId: definition.environmentId,
              projectId: definition.projectId,
            },
          },
  };
}

const StoredJob = Schema.Struct({
  ...RepositoryWorkflowJob.fields,
  runtime: Schema.optional(RepositoryWorkflowJob.fields.runtime),
  environmentId: Schema.optional(EnvironmentId),
  workflow: Schema.NullOr(StoredWorkflow),
});
const readJob = Schema.decodeUnknownSync(StoredJob);
export function normalizeStoredWorkflowJob(value: unknown): RepositoryWorkflowJob {
  const { environmentId: _hint, ...job } = readJob(value);
  const workflow = job.workflow === null ? null : normalizeStoredWorkflow(job.workflow);
  return {
    ...job,
    workflow,
    runtime:
      job.runtime !== undefined
        ? job.runtime
        : workflow?.definition.target.kind === "machine"
          ? workflow.definition.target
          : null,
  };
}
