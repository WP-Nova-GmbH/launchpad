import * as NodeCrypto from "node:crypto";
import type { PgClient } from "@effect/sql-pg/PgClient";
import {
  workflowPublishingPrerequisites,
  type RepositoryWorkflowJob,
  type WorkflowSavedResult,
  type WorkflowVmDispatchBinding,
  type WorkflowVmPublishingAction,
  type WorkflowVmPublishingOutcome,
  type WorkflowVmPublishingRequest,
  type WorkflowVmPublishingResponse,
} from "@t3tools/contracts/workflows";
import { LAUNCHPAD_JOB_BRANCH_PREFIX, jobBranchName } from "@t3tools/shared/workflowStorage";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RelayDb } from "../db.ts";
import { relayInternalErrorResponse } from "../http/Api.ts";
import { tenancyNotFound } from "../http/tenancyErrors.ts";
import { GithubApp } from "../tenancy/GithubApp.ts";
import { ThreadArtifactObjectStorage } from "../threads/ThreadArtifactObjects.ts";
import {
  releaseWorkflowPublishingRecovery,
  retainWorkflowPublishingRecovery,
} from "../threads/WorkflowVmPublishingRecovery.ts";
import { withWorkflowVmGuest } from "./WorkflowVmBinding.ts";
import { observeWorkflowVmGitHub, recheckWorkflowVmGitHub } from "./WorkflowVmGithub.ts";

export type WorkflowVmPublication = WorkflowVmPublishingAction & {
  readonly binding: WorkflowVmDispatchBinding;
  readonly canonicalKey: string;
  readonly installationId: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly recoverySource: {
    readonly backupOperationId: string;
    readonly retentionOperationId: string;
  } | null;
  readonly outcome: WorkflowVmPublishingOutcome | null;
};

const unavailable = () => tenancyNotFound("thread_not_found");
const ok = { kind: "ok" } as const;
class WorkflowVmPublishingWaiting extends Schema.TaggedError<WorkflowVmPublishingWaiting>()(
  "WorkflowVmPublishingWaiting",
  {},
) {}

const readPreviousPush = Effect.fnUntraced(function* (sql: PgClient, jobId: string) {
  const [previous] = yield* sql<{ record: WorkflowVmPublication; commitObject: string | null }>`
    SELECT record,commit_object AS "commitObject" FROM relay_workflow_vm_publications
    WHERE job_id=${jobId} AND record->>'operation'='push'
      AND record #>> '{outcome,commitSha}' IS NOT NULL ORDER BY ordinal DESC LIMIT 1`;
  return previous ?? null;
});

const selectPublication = Effect.fnUntraced(function* (
  sql: PgClient,
  jobId: string,
  actionId?: string,
) {
  const [row] = yield* sql<{ record: WorkflowVmPublication; commitObject: string | null }>`
    SELECT record,commit_object AS "commitObject" FROM relay_workflow_vm_publications
    WHERE job_id=${jobId} ${actionId === undefined ? sql`` : sql`AND action_id=${actionId}`}
    ORDER BY ordinal DESC LIMIT 1`;
  return row ?? null;
});

export const readWorkflowVmPublishing = Effect.fnUntraced(function* (
  sql: PgClient,
  jobId: string,
  actionId?: string,
) {
  return (yield* selectPublication(sql, jobId, actionId))?.record ?? null;
});

export const readWorkflowVmPublishCommands = Effect.fnUntraced(function* (
  sql: PgClient,
  jobId: string,
  actionId: string,
) {
  return yield* sql<{
    commandId: string;
    allocationId: string;
    generation: number;
    stopped: boolean;
    rejected: boolean;
  }>`
    SELECT command_id AS "commandId",allocation_id AS "allocationId",generation,
      stopped_at IS NOT NULL AS stopped,authorization_rejected_at IS NOT NULL AS rejected
    FROM relay_workflow_vm_publish_commands
    WHERE job_id=${jobId} AND action_id=${actionId}`;
});

const stoppedBeforeArmKey = (binding: WorkflowVmDispatchBinding, commandId: string) =>
  JSON.stringify([binding.allocationId, binding.generation, commandId]);

/** The caller holds the job and placement locks through the command claim. */
export const claimWorkflowVmPublishCommand = Effect.fnUntraced(function* (
  sql: PgClient,
  binding: WorkflowVmDispatchBinding,
  actionId: string,
  command: { commandId: string; pid: number; identity: string },
) {
  const [claim] = yield* sql`INSERT INTO relay_workflow_vm_publish_commands
    (command_id,job_id,action_id,allocation_id,generation,pid,process_identity)
    SELECT ${command.commandId},job.job_id,${actionId},${binding.allocationId},
      ${binding.generation},${command.pid},${command.identity}
    FROM relay_workflow_jobs job JOIN relay_workflow_vm_publications publication
      ON publication.job_id=job.job_id AND publication.action_id=${actionId}
    WHERE job.job_id=${binding.jobId}
      AND job.status NOT IN ('cancelling','cancelled','done','failed')
      AND job.pending_control#>>'{response,operation}' IS DISTINCT FROM 'cancel'
      AND NOT COALESCE(publication.record->'stoppedBeforeArm' ? ${stoppedBeforeArmKey(
        binding,
        command.commandId,
      )}::text, false)
    ON CONFLICT DO NOTHING RETURNING command_id`;
  return claim !== undefined;
});

/** A stop without an arm fences its delayed request but is not a delivery receipt. */
export const stopWorkflowVmPublishCommand = Effect.fnUntraced(function* (
  sql: PgClient,
  binding: WorkflowVmDispatchBinding,
  actionId: string,
  commandId: string,
) {
  const stoppedKey = stoppedBeforeArmKey(binding, commandId);
  yield* sql`WITH stopped AS (
    UPDATE relay_workflow_vm_publish_commands SET stopped_at=COALESCE(stopped_at,now())
      WHERE command_id=${commandId} AND job_id=${binding.jobId}
        AND action_id=${actionId} AND allocation_id=${binding.allocationId}
        AND generation=${binding.generation}
      RETURNING command_id
    ) UPDATE relay_workflow_vm_publications SET record=jsonb_set(record,'{stoppedBeforeArm}',
      COALESCE(record->'stoppedBeforeArm','{}'::jsonb) || jsonb_build_object(${stoppedKey}::text,true))
    WHERE job_id=${binding.jobId} AND action_id=${actionId} AND NOT EXISTS (SELECT 1 FROM stopped)`;
});

function pullRequestNumber(canonicalKey: string, url: string | null) {
  const prefix = `https://${canonicalKey}/pull/`;
  if (!url || url.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return undefined;
  const number = url.slice(prefix.length);
  return /^[1-9][0-9]*$/u.test(number) && Number.isSafeInteger(Number(number))
    ? Number(number)
    : undefined;
}

export function normalizeWorkflowVmPullRequestUrl(canonicalKey: string, url: string | null) {
  const number = pullRequestNumber(canonicalKey, url);
  return number === undefined ? null : `https://${canonicalKey}/pull/${number}`;
}

const observePublication = Effect.fn("WorkflowVmPublishing.observe")(function* (
  publication: WorkflowVmPublication,
  requireHead: boolean,
  candidateNumber?: number,
) {
  const { binding, canonicalKey, installationId, branch, baseBranch, operation, commitSha } =
    publication;
  if (!commitSha) return null;
  const url = publication.outcome?.pullRequestUrl ?? publication.pullRequestUrl;
  const recordedNumber = pullRequestNumber(canonicalKey, url);
  if (url && recordedNumber === undefined) return null;
  const number = recordedNumber ?? candidateNumber;
  const observed = yield* observeWorkflowVmGitHub({
    organizationId: binding.organizationId,
    repositoryId: binding.repositoryId,
    canonicalKey,
    installationId,
    target:
      operation === "push"
        ? { kind: "branch", branch }
        : { kind: "pull_request", branch, ...(number === undefined ? {} : { number }) },
  }).pipe(Effect.timeout("12 seconds"), Effect.option);
  if (observed._tag === "None") return null;
  if (observed.value.kind === "branch")
    return observed.value.sha === commitSha ? { commitSha, pullRequestUrl: null } : null;
  const repository = canonicalKey.slice("github.com/".length).toLowerCase();
  const marker = `<!-- launchpad-workflow-job:${binding.jobId} -->`;
  const [pull, ...others] = observed.value.pullRequests;
  if (
    !pull ||
    others.length ||
    pull.headBranch !== branch ||
    pull.baseBranch !== baseBranch ||
    pull.headRepository?.toLowerCase() !== repository ||
    pull.baseRepository.toLowerCase() !== repository ||
    (requireHead && (pull.headSha !== commitSha || pull.state !== "open")) ||
    (number !== undefined && pull.number !== number) ||
    (recordedNumber === undefined && !pull.body.includes(marker))
  )
    return null;
  return { commitSha, pullRequestUrl: pull.url };
});

export const observeWorkflowVmPublishing = (publication: WorkflowVmPublication) =>
  observePublication(publication, true);

export function knownWorkflowVmPublishingCancellation(publication: WorkflowVmPublication) {
  if (publication.outcome) return publication.outcome;
  if (publication.operation !== "open_pull_request" || !publication.commitSha) return null;
  const pullRequestUrl = normalizeWorkflowVmPullRequestUrl(
    publication.canonicalKey,
    publication.pullRequestUrl,
  );
  return pullRequestUrl ? { commitSha: publication.commitSha, pullRequestUrl } : null;
}

/** Cancellation confirms any PR already created for this job, even if its head moved or it closed. */
export const observeWorkflowVmPublishingCancellation = (publication: WorkflowVmPublication) => {
  const known = knownWorkflowVmPublishingCancellation(publication);
  return known ? Effect.succeed(known) : observePublication(publication, false);
};

function sameIntent(recorded: WorkflowVmPublication, intent: WorkflowVmPublishingAction) {
  return (
    recorded.actionId === intent.actionId &&
    recorded.stepId === intent.stepId &&
    recorded.stepGeneration === intent.stepGeneration &&
    recorded.operation === intent.operation &&
    recorded.resultTurnId === intent.resultTurnId &&
    recorded.checkpointRef === intent.checkpointRef &&
    recorded.tree === intent.tree &&
    recorded.parent === intent.parent &&
    recorded.commitSha === intent.commitSha &&
    recorded.oldRemoteSha === intent.oldRemoteSha
  );
}

function checkCommit(encoded: string, sha: string, parent: string, tree: string): boolean {
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > 128 * 1024 || bytes.toString("base64") !== encoded)
    return false;
  const digest = NodeCrypto.createHash("sha1")
    .update(`commit ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  const header = bytes.toString("utf8").split("\n\n", 1)[0]?.split("\n") ?? [];
  const parents = header.filter((line) => line.startsWith("parent "));
  return (
    digest === sha &&
    header[0] === `tree ${tree}` &&
    parents.length === 1 &&
    parents[0] === `parent ${parent}`
  );
}

export const handleWorkflowVmPublishing = Effect.fn("WorkflowVmPublishing.request")(
  function* (input: WorkflowVmPublishingRequest & { environmentId: string; threadId: string }) {
    const sql = (yield* RelayDb).$client;
    const app = yield* GithubApp;
    const objects = yield* ThreadArtifactObjectStorage;
    const { action, request } = input;
    const transaction = <A, E, R>(use: (record: WorkflowVmPublication) => Effect.Effect<A, E, R>) =>
      withWorkflowVmGuest(input, "active", ({ binding, snapshot }) =>
        Effect.gen(function* () {
          const [row] = yield* sql<{
            record: RepositoryWorkflowJob;
            pending: { response?: { operation?: string } } | null;
          }>`SELECT record,pending_control AS pending FROM relay_workflow_jobs WHERE job_id=${binding.jobId}`;
          if (
            !row?.record.workflow ||
            row.record.startAttempted !== true ||
            !snapshot.workflowPublishing
          )
            return yield* unavailable();
          const job = row.record;
          const steps = row.record.workflow.definition.steps;
          const position = steps.findIndex((step) => step.id === action.stepId);
          const step = steps[position];
          const { agent } = workflowPublishingPrerequisites(steps, position);
          if (
            step?.kind !== "action" ||
            step.action !== action.operation ||
            agent?.kind !== "agent" ||
            action.actionId !==
              `workflow:${binding.jobId}:action:${action.stepId}:${action.stepGeneration}`
          )
            return yield* unavailable();
          if (request.kind !== "stop") {
            if (
              row.pending?.response?.operation === "cancel" ||
              ["cancelling", "cancelled", "done", "failed"].includes(job.status) ||
              (job.progress?.generation ?? 0) > action.stepGeneration
            )
              return yield* unavailable();
            const [pin] = yield* sql<{ result: WorkflowSavedResult }>`
              SELECT result FROM relay_workflow_saved_results
              WHERE job_id=${binding.jobId} AND result->>'outcome'='completed'
              ORDER BY revision DESC LIMIT 1`;
            if (
              !pin ||
              pin.result.turnId !== action.resultTurnId ||
              pin.result.treeId !== action.tree ||
              pin.result.checkpointRef !== action.checkpointRef ||
              pin.result.stepId !== agent.id
            )
              return yield* unavailable();
            if (request.kind !== "recover_commit") {
              const progress = job.progress;
              if (
                progress?.stepId !== action.stepId ||
                progress.generation !== action.stepGeneration ||
                !progress.actions?.some(
                  (entry) => entry.actionId === action.actionId && entry.state !== "completed",
                ) ||
                progress.checkpoint
              ) {
                if (request.kind === "credential" && request.access === "read")
                  return yield* new WorkflowVmPublishingWaiting();
                return yield* unavailable();
              }
            }
            yield* recheckWorkflowVmGitHub(sql, binding, snapshot);
          }
          const previous = yield* readWorkflowVmPublishing(sql, binding.jobId, action.actionId);
          return yield* use({
            ...action,
            binding,
            canonicalKey: snapshot.canonicalKey,
            installationId: snapshot.installationId,
            baseBranch: snapshot.branch,
            branch: jobBranchName(binding.jobId, LAUNCHPAD_JOB_BRANCH_PREFIX),
            recoverySource: previous?.recoverySource ?? null,
            outcome: previous?.outcome ?? null,
          });
        }),
      );
    const ensureIntent = (publication: WorkflowVmPublication, commitObject: string | null) =>
      Effect.gen(function* () {
        const { binding, actionId } = publication;
        const existing = yield* selectPublication(sql, binding.jobId, actionId);
        if (existing) {
          if (
            !sameIntent(existing.record, {
              ...publication,
              commitSha: existing.record.commitSha === null ? null : publication.commitSha,
            }) ||
            (commitObject !== null &&
              existing.commitObject !== null &&
              existing.commitObject !== commitObject)
          )
            return yield* unavailable();
          if (existing.record.commitSha === null && publication.commitSha !== null) {
            if (publication.operation === "push" && commitObject === null)
              return yield* unavailable();
            if (
              publication.operation === "open_pull_request" &&
              publication.commitSha !== publication.oldRemoteSha
            )
              return yield* unavailable();
            const record = { ...existing.record, commitSha: publication.commitSha };
            yield* sql`UPDATE relay_workflow_vm_publications SET record=${sql.json(record)},
              commit_object=${commitObject} WHERE job_id=${binding.jobId} AND action_id=${actionId}`;
            return record;
          }
          return existing.record;
        }
        const previousPush = yield* readPreviousPush(sql, binding.jobId);
        if ((previousPush?.record.outcome?.commitSha ?? null) !== publication.oldRemoteSha)
          return yield* unavailable();
        if (
          publication.operation === "open_pull_request" &&
          (!previousPush ||
            previousPush.record.resultTurnId !== publication.resultTurnId ||
            (publication.commitSha !== null &&
              previousPush.record.outcome?.commitSha !== publication.commitSha))
        )
          return yield* unavailable();
        const recoverySource =
          (previousPush?.record.resultTurnId === publication.resultTurnId
            ? previousPush.record.recoverySource
            : null) ??
          (yield* retainWorkflowPublishingRecovery(sql, objects, binding, {
            resultTurnId: publication.resultTurnId,
            resultTreeId: publication.tree,
          }));
        const record = { ...publication, recoverySource };
        yield* sql`INSERT INTO relay_workflow_vm_publications(job_id,action_id,record,commit_object)
          VALUES (${binding.jobId},${actionId},${sql.json(record)},${commitObject})`;
        yield* releaseWorkflowPublishingRecovery(
          sql,
          binding.jobId,
          recoverySource?.retentionOperationId,
        );
        return record;
      });

    if (request.kind === "credential") {
      const write = request.access !== "read";
      if (write && (request.access !== action.operation || !action.commitSha))
        return yield* unavailable();
      const context = yield* transaction((publication) =>
        Effect.gen(function* () {
          if (write) {
            const prior = yield* selectPublication(sql, input.jobId, action.actionId);
            if (
              action.operation === "push" &&
              (!prior?.commitObject || !sameIntent(prior.record, action))
            )
              return yield* unavailable();
            if (action.operation === "open_pull_request") yield* ensureIntent(publication, null);
          } else if (!(yield* readWorkflowVmPublishing(sql, input.jobId, action.actionId))) {
            yield* ensureIntent({ ...publication, commitSha: null }, null);
          }
          return publication;
        }),
      );
      const bot = yield* app.gitMetadata;
      if (bot.status !== "ready") return yield* unavailable();
      const token = yield* app.mintRepositoryToken({
        installationId: context.installationId,
        canonicalKey: context.canonicalKey,
        access:
          request.access === "push"
            ? "workflow-push"
            : request.access === "open_pull_request"
              ? "workflow-pr"
              : action.operation === "push"
                ? "read"
                : "workflow-read-pr",
      });
      yield* transaction((current) =>
        current.installationId === context.installationId &&
        current.canonicalKey === context.canonicalKey
          ? Effect.void
          : unavailable(),
      );
      return {
        kind: "credential",
        ...token,
        bot: { name: bot.name, email: bot.email },
      } satisfies WorkflowVmPublishingResponse;
    }

    if (request.kind === "settle") {
      const recorded = yield* transaction((publication) =>
        action.operation === "open_pull_request"
          ? ensureIntent(publication, null)
          : readWorkflowVmPublishing(sql, input.jobId, action.actionId),
      );
      if (
        !recorded ||
        !sameIntent(recorded, action) ||
        request.outcome.commitSha !== recorded.commitSha
      )
        return yield* unavailable();
      const outcome = {
        commitSha: request.outcome.commitSha,
        pullRequestUrl: normalizeWorkflowVmPullRequestUrl(
          recorded.canonicalKey,
          request.outcome.pullRequestUrl,
        ),
      };
      if (
        recorded.operation === "push"
          ? request.outcome.pullRequestUrl !== null
          : outcome.pullRequestUrl === null
      )
        return yield* unavailable();
      if (!recorded.outcome) {
        const verified = yield* observeWorkflowVmPublishing(recorded);
        if (
          !verified ||
          verified.commitSha !== outcome.commitSha ||
          verified.pullRequestUrl !== outcome.pullRequestUrl
        )
          return yield* unavailable();
      }
      return yield* transaction(() =>
        Effect.gen(function* () {
          const [running] = yield* sql`SELECT 1 FROM relay_workflow_vm_publish_commands
          WHERE job_id=${input.jobId} AND stopped_at IS NULL`;
          if (running) return yield* unavailable();
          const current = yield* readWorkflowVmPublishing(sql, input.jobId, action.actionId);
          if (!current || !sameIntent(current, action)) return yield* unavailable();
          if (
            current.outcome &&
            (current.outcome.commitSha !== outcome.commitSha ||
              current.outcome.pullRequestUrl !== outcome.pullRequestUrl)
          )
            return yield* unavailable();
          yield* sql`UPDATE relay_workflow_vm_publications
          SET record=record || ${sql.json({ outcome })}
          WHERE job_id=${input.jobId} AND action_id=${action.actionId}`;
          return ok;
        }),
      );
    }

    if (request.kind === "record_pull") {
      const recorded = yield* transaction((publication) =>
        action.operation === "open_pull_request" ? ensureIntent(publication, null) : unavailable(),
      );
      const number = pullRequestNumber(recorded.canonicalKey, request.url);
      const url = normalizeWorkflowVmPullRequestUrl(recorded.canonicalKey, request.url);
      if (
        number === undefined ||
        !url ||
        (recorded.pullRequestUrl &&
          pullRequestNumber(recorded.canonicalKey, recorded.pullRequestUrl) !== number)
      )
        return yield* unavailable();
      const confirmed = yield* observePublication(recorded, false, number);
      if (confirmed?.pullRequestUrl !== url) return yield* unavailable();
      return yield* transaction(() =>
        Effect.gen(function* () {
          const [written] = yield* sql`UPDATE relay_workflow_vm_publications
          SET record=record || ${sql.json({ pullRequestUrl: url })}
          WHERE job_id=${input.jobId} AND action_id=${action.actionId}
            AND (record->>'pullRequestUrl' IS NULL OR lower(record->>'pullRequestUrl')=lower(${url}))
          RETURNING action_id`;
          if (!written) return yield* unavailable();
          return ok;
        }),
      );
    }

    return yield* transaction((publication) =>
      Effect.gen(function* () {
        switch (request.kind) {
          case "retain": {
            const [provision] = yield* sql<{ baseSha: string }>`
            SELECT workflow_snapshot->>'commitSha' AS "baseSha" FROM relay_thread_vm_provisions
            WHERE allocation_id=${publication.binding.allocationId}`;
            if (!provision || action.operation !== "push" || !action.commitSha)
              return yield* unavailable();
            if (action.commitSha === action.oldRemoteSha) {
              const previous = yield* readPreviousPush(sql, input.jobId);
              if (
                previous?.record.outcome?.commitSha !== action.commitSha ||
                previous.record.tree !== action.tree ||
                previous.commitObject !== request.commit
              )
                return yield* unavailable();
            } else if (
              !checkCommit(
                request.commit,
                action.commitSha,
                action.oldRemoteSha ?? provision.baseSha,
                action.tree,
              )
            )
              return yield* unavailable();
            yield* ensureIntent(publication, request.commit);
            return ok;
          }
          case "recover_commit": {
            const prior = yield* selectPublication(sql, input.jobId, action.actionId);
            if (
              prior &&
              prior.record.resultTurnId === action.resultTurnId &&
              prior.record.tree === action.tree &&
              prior.record.commitSha === request.sha
            )
              return { kind: "commit", commit: prior.commitObject } as const;
            return { kind: "commit", commit: null } as const;
          }
          case "arm": {
            const prior = yield* selectPublication(sql, input.jobId, action.actionId);
            if (
              !prior?.record.commitSha ||
              prior.record.outcome ||
              !sameIntent(prior.record, action) ||
              (action.operation === "push" && !prior.commitObject)
            )
              return yield* unavailable();
            if (action.operation === "open_pull_request") {
              if (prior.record.pullRequestUrl) return yield* unavailable();
              const seen = yield* readWorkflowVmPublishCommands(sql, input.jobId, action.actionId);
              if (seen.some((command) => !command.rejected)) return yield* unavailable();
            }
            if (
              !(yield* claimWorkflowVmPublishCommand(
                sql,
                publication.binding,
                action.actionId,
                request,
              ))
            )
              return yield* unavailable();
            return ok;
          }
          case "stop":
            yield* stopWorkflowVmPublishCommand(
              sql,
              publication.binding,
              action.actionId,
              request.commandId,
            );
            return ok;
          case "can_create_pull": {
            if (action.operation !== "open_pull_request") return yield* unavailable();
            const prior = yield* readWorkflowVmPublishing(sql, input.jobId, action.actionId);
            const seen = yield* readWorkflowVmPublishCommands(sql, input.jobId, action.actionId);
            return {
              kind: "can_create_pull",
              allowed: !prior?.pullRequestUrl && seen.every((command) => command.rejected),
            } as const;
          }
          case "reject_pull_authorization": {
            if (action.operation !== "open_pull_request") return yield* unavailable();
            const [rejected] = yield* sql`UPDATE relay_workflow_vm_publish_commands
            SET authorization_rejected_at=COALESCE(authorization_rejected_at,now())
            WHERE command_id=${request.commandId} AND job_id=${input.jobId}
              AND action_id=${action.actionId} AND allocation_id=${publication.binding.allocationId}
              AND generation=${input.generation} AND stopped_at IS NOT NULL
            RETURNING command_id`;
            if (!rejected) return yield* unavailable();
            return ok;
          }
        }
      }),
    );
  },
  Effect.catchTags({
    SqlError: () => relayInternalErrorResponse("persistence_failed"),
    GithubAppNotConfigured: () => relayInternalErrorResponse("upstream_unavailable"),
    GithubRequestFailed: () => relayInternalErrorResponse("upstream_unavailable"),
    WorkflowInvalidError: () => tenancyNotFound("thread_not_found"),
    ThreadNativeCheckpointConflict: () => tenancyNotFound("thread_not_found"),
    SchemaError: () => relayInternalErrorResponse("persistence_failed"),
    WorkflowVmPublishingWaiting: () => Effect.succeed({ kind: "waiting_progress" } as const),
  }),
);
