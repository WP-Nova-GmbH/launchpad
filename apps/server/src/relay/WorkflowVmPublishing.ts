import {
  WORKFLOW_VM_PUBLISHING_PROTOCOL,
  type WorkflowVmDispatchBinding,
  type WorkflowVmPublishingRequest,
  type WorkflowVmPublishingResponse,
} from "@t3tools/contracts/workflows";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";
import { layer as serverSecretStoreLayer } from "../auth/ServerSecretStore.ts";
import { WorkflowActionError, type WorkflowVmPublishingIO } from "../jobs/WorkflowActions.ts";
import type { WorkflowRun } from "../jobs/WorkflowRunStore.ts";
import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";
import { makeExecutorRelayApiClient } from "./executorRelayClient.ts";

const unavailable = () =>
  new WorkflowActionError({
    message: "The relay could not authorize or record this publishing action.",
  });
class PublishingProgressPending extends Schema.TaggedError<PublishingProgressPending>()(
  "PublishingProgressPending",
  {},
) {}

type CallPublishing = (
  binding: WorkflowVmDispatchBinding,
  action: WorkflowVmPublishingRequest["action"],
  request: WorkflowVmPublishingRequest["request"],
) => Effect.Effect<WorkflowVmPublishingResponse, WorkflowActionError>;

export class WorkflowVmPublisher extends Context.Reference<CallPublishing>(
  "t3/relay/WorkflowVmPublisher",
  { defaultValue: () => () => Effect.fail(unavailable()) },
) {
  static readonly layer = Layer.effect(
    WorkflowVmPublisher,
    Effect.gen(function* () {
      const vm = yield* readInstalledThreadVm();
      const url = vm && normalizeSecureRelayUrl(vm.relayUrl);
      const issuer = vm && normalizeSecureRelayUrl(vm.relayIssuer);
      const client =
        vm && url && issuer
          ? yield* makeExecutorRelayApiClient({
              url,
              issuer,
              environmentCredential: vm.environmentCredential,
            })
          : null;
      return Effect.fnUntraced(function* (
        binding: WorkflowVmDispatchBinding,
        action: WorkflowVmPublishingRequest["action"],
        request: WorkflowVmPublishingRequest["request"],
      ) {
        if (
          !client ||
          !vm ||
          vm.environmentId !== binding.environmentId ||
          vm.operationId !== binding.operationId ||
          vm.scope.allocationId !== binding.allocationId ||
          vm.scope.threadId !== binding.threadId ||
          vm.scope.repositoryId !== binding.repositoryId ||
          vm.scope.generation !== binding.generation
        )
          return yield* unavailable();
        return yield* client.threadEnvironment
          .workflowVmPublishing({
            params: { environmentId: binding.environmentId, threadId: binding.threadId },
            payload: {
              jobId: binding.jobId,
              generation: binding.generation,
              vmPublishingProtocol: WORKFLOW_VM_PUBLISHING_PROTOCOL,
              action,
              request,
            },
          })
          .pipe(
            Effect.flatMap((reply) =>
              reply.kind === "waiting_progress"
                ? Effect.fail(new PublishingProgressPending())
                : Effect.succeed(reply),
            ),
            Effect.retry({
              while: (error) => error._tag === "PublishingProgressPending",
              schedule: Schedule.spaced("300 millis"),
              times: 15,
            }),
            Effect.timeout("20 seconds"),
            Effect.mapError(unavailable),
          );
      }) satisfies CallPublishing;
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(serverSecretStoreLayer));
}

export function workflowVmPublishingIO(
  publish: CallPublishing,
  read: Effect.Effect<WorkflowRun, WorkflowActionError>,
): WorkflowVmPublishingIO {
  const call = Effect.fnUntraced(function* (
    actionId: string,
    request: WorkflowVmPublishingRequest["request"],
  ) {
    const run = yield* read;
    const action = run.actions?.find((entry) => entry.actionId === actionId);
    if (run.runtime.kind !== "vm" || !action?.checkpointTurnId || !run.publication)
      return yield* unavailable();
    return yield* publish(
      run.runtime,
      {
        actionId,
        stepId: action.stepId,
        stepGeneration: action.generation,
        operation: action.operation,
        resultTurnId: action.checkpointTurnId,
        checkpointRef: action.checkpointRef,
        tree: action.tree,
        parent: action.parent,
        commitSha: action.commitSha,
        oldRemoteSha: action.oldRemoteSha,
        pullRequestUrl: run.publication.pullRequestUrl,
      },
      request,
    );
  });
  return {
    credential: (id, access) =>
      call(id, { kind: "credential", access }).pipe(
        Effect.flatMap((response) =>
          response.kind === "credential"
            ? Effect.succeed({ token: Redacted.make(response.token), bot: response.bot })
            : Effect.fail(unavailable()),
        ),
      ),
    retain: (id, commit) =>
      call(id, {
        kind: "retain",
        commit: Buffer.from(commit.object).toString("base64"),
      }).pipe(Effect.asVoid),
    recoverCommit: (id, sha) =>
      call(id, { kind: "recover_commit", sha }).pipe(
        Effect.flatMap((response) =>
          response.kind === "commit"
            ? Effect.succeed(
                response.commit === null ? null : Buffer.from(response.commit, "base64"),
              )
            : Effect.fail(unavailable()),
        ),
      ),
    arm: (id, command) =>
      command.pid !== null && command.identity !== null
        ? call(id, {
            kind: "arm",
            commandId: command.id,
            pid: command.pid,
            identity: command.identity,
          }).pipe(Effect.asVoid)
        : Effect.fail(unavailable()),
    stop: (id, commandId) => call(id, { kind: "stop", commandId }).pipe(Effect.asVoid),
    settle: (id, outcome) => call(id, { kind: "settle", outcome }).pipe(Effect.asVoid),
    canCreatePull: (id) =>
      call(id, { kind: "can_create_pull" }).pipe(
        Effect.flatMap((response) =>
          response.kind === "can_create_pull"
            ? Effect.succeed(response.allowed)
            : Effect.fail(unavailable()),
        ),
      ),
    recordPull: (id, url) => call(id, { kind: "record_pull", url }).pipe(Effect.asVoid),
    rejectPullAuthorization: (id, commandId) =>
      call(id, { kind: "reject_pull_authorization", commandId }).pipe(Effect.asVoid),
  };
}
