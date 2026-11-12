import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { RelaySecretBox } from "../auth/SecretBox.ts";
import { readWorkflowConfigurationForFreeze } from "./RepositoryWorkflowConfiguration.ts";
import { WorkflowVmDispatchBinding } from "@t3tools/contracts/workflows";

const identityFields = {
  jobId: Schema.NonEmptyString,
  organizationId: Schema.NonEmptyString,
  repositoryId: Schema.NonEmptyString,
  threadId: Schema.NonEmptyString,
};
const metadataFields = {
  sourceRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  hasSecrets: Schema.Boolean,
};
const identitySchema = Schema.Struct(identityFields);
type RunIdentity = typeof identitySchema.Type;
const metadataSchema = Schema.Struct(metadataFields);
type RunConfigurationMetadata = typeof metadataSchema.Type;
const envelope = Schema.fromJsonString(
  Schema.Struct({
    purpose: Schema.Literal("workflow-run-configuration-v1"),
    ...identityFields,
    ...metadataFields,
    values: Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(["variable", "secret"]),
        name: Schema.NonEmptyString,
        value: Schema.String,
      }),
    ),
  }),
);
const encodeEnvelope = Schema.encodeEffect(envelope);
const decodeEnvelope = Schema.decodeUnknownEffect(envelope);
const encodeAttemptIdentity = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      binding: WorkflowVmDispatchBinding,
      purpose: Schema.Literals(["setup", "agent"]),
      attemptId: Schema.String,
      stepId: Schema.String,
      stepGeneration: Schema.Int,
      commandId: Schema.String,
    }),
  ),
);

export class WorkflowRunConfigurationError extends Schema.TaggedError<WorkflowRunConfigurationError>()(
  "WorkflowRunConfigurationError",
  { reason: Schema.Literals(["unavailable", "not_allowed", "storage"]) },
) {
  override get message() {
    switch (this.reason) {
      case "not_allowed":
        return "The submitter cannot prepare this workflow run with the selected configuration.";
      case "storage":
        return "The workflow run configuration could not be stored or read.";
      case "unavailable":
        return "No workflow run configuration is available for this preparation.";
    }
  }
}

const unavailable = () => new WorkflowRunConfigurationError({ reason: "unavailable" });
const denied = () => new WorkflowRunConfigurationError({ reason: "not_allowed" });
const isRunConfigurationError = Schema.is(WorkflowRunConfigurationError);
const safeError = (error: unknown) =>
  new WorkflowRunConfigurationError({
    reason: isRunConfigurationError(error) ? error.reason : "storage",
  });

const requireRepository = Effect.fnUntraced(function* (sql: PgClient, identity: RunIdentity) {
  // Also serializes against the first settings write, when there is no config row to lock.
  const [repository] = yield* sql`SELECT repository_id FROM relay_repositories
    WHERE repository_id=${identity.repositoryId} AND organization_id=${identity.organizationId} FOR SHARE`;
  if (!repository) return yield* unavailable();
});

const readSnapshot = (sql: PgClient, identity: RunIdentity) =>
  sql<RunConfigurationMetadata & { threadId: string; sealedPayload: string }>`
    SELECT thread_id AS "threadId",source_revision AS "sourceRevision",
      has_secrets AS "hasSecrets",sealed_payload AS "sealedPayload"
    FROM relay_workflow_run_configurations WHERE job_id=${identity.jobId}
      AND organization_id=${identity.organizationId} AND repository_id=${identity.repositoryId} FOR SHARE`;

const openSnapshot = Effect.fnUntraced(function* (
  sql: PgClient,
  box: RelaySecretBox["Service"],
  identity: RunIdentity,
) {
  const [snapshot] = yield* readSnapshot(sql, identity);
  if (!snapshot || snapshot.threadId !== identity.threadId) return yield* unavailable();
  const opened = yield* decodeEnvelope(yield* box.open(snapshot.sealedPayload));
  if (
    opened.jobId !== identity.jobId ||
    opened.organizationId !== identity.organizationId ||
    opened.repositoryId !== identity.repositoryId ||
    opened.threadId !== identity.threadId ||
    opened.sourceRevision !== snapshot.sourceRevision ||
    opened.hasSecrets !== snapshot.hasSecrets ||
    opened.hasSecrets !== opened.values.some((entry) => entry.kind === "secret")
  )
    return yield* unavailable();
  return opened;
});

const requirePreparingJob = Effect.fnUntraced(function* (sql: PgClient, identity: RunIdentity) {
  const [job] = yield* sql`SELECT job_id FROM relay_workflow_jobs WHERE job_id=${identity.jobId}
    AND organization_id=${identity.organizationId} AND repository_id=${identity.repositoryId}
    AND status='preparing' AND record->>'status'='preparing' AND pending_control IS NULL
    AND record#>>'{workflow,definition,target,kind}'='vm' AND record#>>'{runtime,kind}'='vm'
    AND record#>>'{runtime,threadId}'=${identity.threadId} FOR SHARE`;
  if (!job) return yield* unavailable();
});

/** Run the caller's DB-only acceptance in the same transaction as the first freeze. */
export const withFrozenWorkflowRunConfiguration = <E, R>(
  sql: PgClient,
  box: RelaySecretBox["Service"],
  identity: RunIdentity,
  acceptPreparation: Effect.Effect<void, E, R>,
) =>
  sql
    .withTransaction(
      Effect.gen(function* () {
        const { jobId, organizationId, repositoryId, threadId } = identity;
        // The submitter is immutable. Read the hint before taking authority locks,
        // then verify it again when the job row is locked.
        const [hint] = yield* sql<{ userId: string | null }>`
        SELECT submitter_user_id AS "userId" FROM relay_workflow_jobs WHERE job_id=${jobId}
          AND organization_id=${organizationId} AND repository_id=${repositoryId}`;
        if (!hint) return yield* unavailable();
        const [member] = hint.userId
          ? yield* sql<{ role: string }>`SELECT role FROM relay_organization_members
            WHERE user_id=${hint.userId} AND organization_id=${organizationId} FOR SHARE`
          : [];
        const [grant] =
          hint.userId && member && member.role !== "admin"
            ? yield* sql<{ role: string }>`SELECT role FROM relay_repository_access
            WHERE user_id=${hint.userId} AND organization_id=${organizationId}
              AND repository_id=${repositoryId} FOR SHARE`
            : [];
        yield* requireRepository(sql, identity);
        const [job] = yield* sql<{ userId: string | null; queued: boolean }>`
        SELECT submitter_user_id AS "userId", (status='queued' AND record->>'status'='queued'
          AND pending_control IS NULL AND record->'workflow'='null'::jsonb
          AND record->'runtime'='null'::jsonb) AS queued
        FROM relay_workflow_jobs WHERE job_id=${jobId} AND organization_id=${organizationId}
          AND repository_id=${repositoryId} FOR NO KEY UPDATE`;
        if (!job || job.userId !== hint.userId) return yield* unavailable();

        const [prior] = yield* readSnapshot(sql, identity);
        if (prior) {
          if (prior.threadId !== threadId) return yield* unavailable();
          yield* requirePreparingJob(sql, identity);
          return { sourceRevision: prior.sourceRevision, hasSecrets: prior.hasSecrets };
        }
        // An accepted job with missing storage must never pick up live settings on replay.
        if (!job.queued) return yield* unavailable();
        if (job.userId !== null && (!member || (member.role !== "admin" && !grant)))
          return yield* denied();
        const {
          revision: sourceRevision,
          values,
          hasSecrets,
        } = yield* readWorkflowConfigurationForFreeze(sql, box, { organizationId, repositoryId });
        if (
          job.userId !== null &&
          hasSecrets &&
          member?.role !== "admin" &&
          grant?.role !== "maintainer"
        )
          return yield* denied();

        const sealedPayload = yield* box.seal(
          yield* encodeEnvelope({
            purpose: "workflow-run-configuration-v1",
            ...identity,
            sourceRevision,
            hasSecrets,
            values,
          }),
        );
        yield* sql`INSERT INTO relay_workflow_run_configurations
        (job_id,organization_id,repository_id,thread_id,source_revision,has_secrets,sealed_payload)
        VALUES (${jobId},${organizationId},${repositoryId},${threadId},${sourceRevision},${hasSecrets},${sealedPayload})`;
        yield* acceptPreparation;
        yield* requirePreparingJob(sql, identity);
        return { sourceRevision, hasSecrets };
      }),
    )
    .pipe(Effect.mapError(safeError));

/** The worker supplies its current claim and the exact target of the pending setup. */
export type WorkflowRunSetupClaim = RunIdentity & {
  readonly claimId: string;
  readonly operationId: string;
  readonly allocationId: string;
  readonly environmentId: string;
  readonly credentialId: string;
  readonly computeRef: string;
  readonly generation: number;
};

/** Resolve initial setup only, before network I/O. Recheck the claim at handoff and receipt. */
export const resolveWorkflowRunSetupConfiguration = Effect.fnUntraced(function* (
  sql: PgClient,
  box: RelaySecretBox["Service"],
  claim: WorkflowRunSetupClaim,
) {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const {
        jobId,
        threadId,
        organizationId,
        repositoryId,
        operationId,
        allocationId,
        generation,
        environmentId,
        credentialId,
        computeRef,
        claimId,
      } = claim;
      // Initial assignment is generation one. Restore has a separate authority path.
      if (generation !== 1) return yield* unavailable();
      yield* requireRepository(sql, claim);
      yield* requirePreparingJob(sql, claim);
      // Placement then allocation then provision follows VM assignment and provisioning.
      const [placement] = yield* sql`SELECT thread_id FROM relay_thread_placements
        WHERE thread_id=${threadId} AND audience='repository' AND workflow_job_id=${jobId}
          AND organization_id=${organizationId} AND repository_id=${repositoryId}
          AND generation=${generation} AND operation_id=${operationId}
          AND environment_id=${environmentId} AND project_id=${`vm:${threadId}`}
          AND NOT EXISTS (SELECT 1 FROM relay_thread_deletions WHERE thread_id=${threadId}) FOR SHARE`;
      if (!placement) return yield* unavailable();
      const [allocation] = yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations
        WHERE allocation_id=${allocationId} AND thread_id=${threadId} AND organization_id=${organizationId}
          AND runtime_protocol='native-v1' AND resource_kind='organization_workflow'
          AND compute_ref=${computeRef} AND state='running' AND deleted_at IS NULL FOR SHARE`;
      if (!allocation) return yield* unavailable();
      const [provision] = yield* sql`SELECT allocation_id FROM relay_thread_vm_provisions
        WHERE allocation_id=${allocationId} AND generation=${generation} AND operation_id=${operationId}
          AND phase='created' AND ingress_recovery_claim_id IS NULL
          AND claim_id=${claimId} AND claim_until>clock_timestamp() FOR SHARE`;
      if (!provision) return yield* unavailable();
      const [setup] = yield* sql`SELECT allocation_id FROM relay_thread_vm_setups
        WHERE allocation_id=${allocationId} AND phase IN ('pending','running')
          AND (environment_id IS NULL OR environment_id=${environmentId}) FOR SHARE`;
      if (!setup) return yield* unavailable();
      const [binding] = yield* sql`SELECT b.environment_id FROM relay_thread_vm_bindings b
        JOIN relay_thread_vm_enrollments e USING (allocation_id)
        JOIN relay_environment_credentials c ON c.credential_id=b.credential_id
        WHERE b.allocation_id=${allocationId} AND b.thread_id=${threadId} AND b.repository_id=${repositoryId}
          AND b.generation=${generation} AND b.environment_id=${environmentId} AND b.credential_id=${credentialId}
          AND b.revoked_at IS NULL AND e.operation_id=${operationId} AND e.installed_at IS NOT NULL
          AND e.environment_id=b.environment_id AND e.environment_public_key=b.environment_public_key
          AND e.credential_id=b.credential_id AND c.environment_id=b.environment_id
          AND c.environment_public_key=b.environment_public_key AND c.revoked_at IS NULL FOR SHARE OF b,e,c`;
      if (!binding) return yield* unavailable();
      const opened = yield* openSnapshot(sql, box, claim);
      // A claim can age out even though its row is still locked.
      const [current] = yield* sql`SELECT allocation_id FROM relay_thread_vm_provisions
        WHERE allocation_id=${allocationId} AND claim_until>clock_timestamp()`;
      if (!current) return yield* unavailable();
      return {
        sourceRevision: opened.sourceRevision,
        hasSecrets: opened.hasSecrets,
        values: Redacted.make(opened.values),
      };
    }),
  );
}, Effect.mapError(safeError));

/** Caller owns the live guest and job locks. Attempts never persist plaintext. */
export const resolveWorkflowRunAttemptConfiguration = Effect.fnUntraced(function* (
  sql: PgClient,
  box: RelaySecretBox["Service"],
  binding: WorkflowVmDispatchBinding,
  attempt: {
    purpose: "setup" | "agent";
    attemptId: string;
    stepId: string;
    stepGeneration: number;
    commandId: string;
  },
) {
  const identity = {
    jobId: binding.jobId,
    organizationId: binding.organizationId,
    repositoryId: binding.repositoryId,
    threadId: binding.threadId,
  };
  const { jobId, organizationId, repositoryId, threadId } = identity;
  if (attempt.attemptId !== attempt.commandId) return yield* denied();
  const setupPrefix = `workflow:${jobId}:`;
  const validCommand =
    attempt.purpose === "setup"
      ? attempt.commandId === `${setupPrefix}start` ||
        (attempt.commandId.startsWith(`${setupPrefix}retry:`) &&
          /^\d{1,16}$/u.test(attempt.commandId.slice(`${setupPrefix}retry:`.length)))
      : /^server:prompt-claim:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(
          attempt.commandId,
        );
  if (!validCommand) return yield* denied();
  const retryRevision =
    attempt.purpose === "setup" && attempt.commandId !== `${setupPrefix}start`
      ? attempt.commandId.slice(`${setupPrefix}retry:`.length)
      : null;
  const [job] = yield* sql`SELECT job_id FROM relay_workflow_jobs j
    WHERE j.job_id=${jobId} AND j.organization_id=${organizationId} AND j.repository_id=${repositoryId}
      AND j.record#>>'{runtime,threadId}'=${threadId} AND j.record->>'startAttempted'='true'
      AND j.status IN ('dispatching','preparing','running','awaiting_review','awaiting_input','paused','waiting_capacity','finishing')
      AND (j.pending_control#>>'{response,operation}') IS DISTINCT FROM 'cancel'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(j.record#>'{workflow,definition,steps}') step
        WHERE step->>'kind'='agent' AND step->>'id'=${attempt.stepId})
      AND coalesce((j.record#>>'{progress,generation}')::int, 0)<=${attempt.stepGeneration}
      AND ${attempt.stepGeneration}<=coalesce((j.record#>>'{progress,generation}')::int, 0)
        + CASE WHEN j.pending_control#>>'{response,operation}'='request_changes' THEN 1 ELSE 0 END
      ${
        attempt.purpose === "setup"
          ? sql`
        AND ${attempt.stepGeneration}=0
        AND ${attempt.stepId}=(SELECT step->>'id'
          FROM jsonb_array_elements(j.record#>'{workflow,definition,steps}') WITH ORDINALITY AS steps(step,n)
          WHERE step->>'kind'='agent' ORDER BY n LIMIT 1)
      `
          : sql``
      }
      ${
        retryRevision === null
          ? sql``
          : sql`
        AND (
          (j.pending_control#>>'{response,operation}'='retry_preparation'
            AND j.pending_control#>>'{response,expectedRevision}'=${retryRevision})
          OR (j.record#>>'{progress,status}'='preparing'
            AND j.record#>>'{progress,revision}'=(${retryRevision}::bigint+1)::text)
          OR EXISTS (SELECT 1 FROM relay_workflow_vm_attempts prior
            WHERE prior.job_id=j.job_id AND prior.attempt_id=${attempt.attemptId})
        )
      `
      }
    FOR SHARE`;
  if (!job) return yield* denied();
  const [placement] = yield* sql`SELECT thread_id FROM relay_thread_placements
    WHERE thread_id=${threadId} AND workflow_job_id=${jobId} AND audience='repository'
      AND organization_id=${organizationId} AND repository_id=${repositoryId}
      AND environment_id=${binding.environmentId} AND generation=${binding.generation}
      AND operation_id IS NULL FOR SHARE`;
  if (!placement) return yield* denied();
  const attemptIdentity = yield* encodeAttemptIdentity({ binding, ...attempt });
  yield* sql`INSERT INTO relay_workflow_vm_attempts(job_id,attempt_id,identity)
    VALUES (${jobId},${attempt.attemptId},${attemptIdentity}::jsonb) ON CONFLICT DO NOTHING`;
  const [registration] = yield* sql`SELECT attempt_id FROM relay_workflow_vm_attempts
    WHERE job_id=${jobId} AND attempt_id=${attempt.attemptId} AND identity=${attemptIdentity}::jsonb FOR SHARE`;
  if (!registration) return yield* denied();
  const opened = yield* openSnapshot(sql, box, identity);
  return {
    environment: Object.fromEntries(opened.values.map(({ name, value }) => [name, value])),
    hasSecrets: opened.hasSecrets,
    secretNames: opened.values.filter(({ kind }) => kind === "secret").map(({ name }) => name),
  };
}, Effect.mapError(safeError));

/** For the exact live guest's server to check shared patches, including after completion. */
export const readWorkflowRunReviewSecrets = Effect.fnUntraced(function* (
  sql: PgClient,
  box: RelaySecretBox["Service"],
  binding: WorkflowVmDispatchBinding,
) {
  const opened = yield* openSnapshot(sql, box, binding);
  return Redacted.make(
    opened.values.filter(({ kind }) => kind === "secret").map(({ value }) => value),
  );
}, Effect.mapError(safeError));
