import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  WorkflowInvalidError,
  type SaveRepositoryWorkflow,
  type RepositoryWorkflow,
} from "@t3tools/contracts/workflows";
import { WorkflowSourceError, RelayJobId } from "@t3tools/contracts/relay";
import { RelayDb } from "../db.ts";
import { EnvironmentConnector } from "../environments/EnvironmentConnector.ts";
import { validateWorkflowTarget } from "../jobs/WorkflowTarget.ts";
import * as Sources from "../workflowSources/Sources.ts";
import * as Store from "../workflowSources/Store.ts";
import * as Fence from "./Fence.ts";
import * as Routing from "./Routing.ts";
const decodeProof = Schema.decodeUnknownOption(Routing.EnableProof);
const isSourceError = Schema.is(WorkflowSourceError);

export const prepare = Effect.fn("workflowEvents.prepareSave")(function* (
  org: string,
  repo: string,
  user: string,
  input: typeof SaveRepositoryWorkflow.Type,
  previous: RepositoryWorkflow | null,
) {
  const next = Routing.automation(
    input.automation === undefined ? previous?.automation : input.automation,
  );
  if (!next.enabled || input.archived) return { userId: user };
  const config = yield* Fence.configuration;
  if (!config?.admissionEnabled || !next.trigger)
    return yield* new WorkflowInvalidError({
      message: "Automatic event admission is not enabled on this relay.",
    });
  const trigger = next.trigger;
  const sql = (yield* RelayDb).$client;
  const bound = yield* sql
    .withTransaction(Store.authority(repo, trigger.grantId, user))
    .pipe(
      Effect.catchTag(
        "WorkflowSourceError",
        (error) => new WorkflowInvalidError({ message: error.message }),
      ),
    );
  if (
    bound.connection.connection_id !== trigger.connectionId ||
    bound.connection.application_id !== config.applicationId ||
    !Fence.covers(bound.connection, config.generation, trigger.teamId)
  )
    return yield* new WorkflowInvalidError({
      message: "Issue creation and status-entry delivery must be verified for this Linear team.",
    });
  const canonicalKey = yield* validateWorkflowTarget(org, repo, input.definition);
  const proof = {
    epoch: bound.connection.authorization_epoch,
    connectionId: trigger.connectionId,
    generation: config.generation,
    triggerKey: Routing.triggerKey(trigger),
    targetKey: Routing.targetKey(input.definition),
    canonicalKey,
  };
  const saved = yield* Routing.read(input.workflowId);
  const cached = decodeProof(saved?.target_capability);
  const sameTarget =
    cached._tag === "Some" &&
    cached.value.targetKey === proof.targetKey &&
    cached.value.canonicalKey === proof.canonicalKey;
  const sameActiveSelection =
    previous?.automation?.enabled &&
    cached._tag === "Some" &&
    cached.value.epoch === proof.epoch &&
    cached.value.connectionId === proof.connectionId &&
    cached.value.generation === proof.generation &&
    cached.value.triggerKey === proof.triggerKey;
  if (!sameActiveSelection)
    yield* Sources.validateTrigger(bound.connection, trigger).pipe(
      Effect.catchIf(
        isSourceError,
        (error) => new WorkflowInvalidError({ message: error.message }),
      ),
    );
  if (sameTarget) return { userId: user, proof };
  const connector = yield* EnvironmentConnector;
  const probeId = yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(
    Effect.mapError(
      () => new WorkflowInvalidError({ message: "Could not validate the environment. Try again." }),
    ),
  );
  const response = yield* connector
    .dispatchJob({
      userId: user,
      workflowOrigin: { kind: "manual", userId: user },
      environmentId: input.definition.environmentId,
      jobId: RelayJobId.make(`probe-${probeId}`),
      repositoryCanonicalKey: canonicalKey,
      baseBranch: "HEAD",
      instruction: "Check workflow automation capability.",
      workflowControl: {
        operation: "status",
        organizationId: org,
        repositoryId: repo,
        projectId: input.definition.projectId,
      },
    })
    .pipe(
      Effect.mapError(
        () =>
          new WorkflowInvalidError({
            message: "Connect this environment to validate automation before enabling it.",
          }),
      ),
    );
  if (
    !response.workflowResult ||
    response.workflowResult.protocol < 8 ||
    input.definition.steps.some(
      (s) => s.kind === "action" && !response.workflowResult?.actions?.includes(s.action),
    )
  )
    return yield* new WorkflowInvalidError({
      message: "Update this environment before enabling this workflow's automatic steps.",
    });
  return { userId: user, proof };
});
