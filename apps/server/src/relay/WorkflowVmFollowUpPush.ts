import * as NodeCrypto from "node:crypto";
import {
  WORKFLOW_VM_FOLLOW_UP_MAX_BUNDLE_BYTES,
  WorkflowVmFollowUpPushError,
  type WorkflowVmFollowUpPublishingRequest,
  type WorkflowVmFollowUpPushResult,
} from "@t3tools/contracts/workflows";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { WorkflowRunStore } from "../jobs/WorkflowRunStore.ts";
import {
  WorkflowVmFollowUpGitError,
  exportWorkflowVmFollowUpBundle,
  installWorkflowVmFollowUpGitBaseline,
  openWorkflowVmFollowUpGit,
  readWorkflowVmFollowUpGitBaseline,
  verifyWorkflowVmFollowUpBundle,
} from "../jobs/WorkflowVmFollowUpGit.ts";
import {
  CurrentWorkflowCommand,
  ProcessOwnershipError,
  type OwnedCommand,
} from "../processRunner.ts";
import { SetupProcessAdapter } from "../terminal/SetupProcessAdapter.ts";
import { readInstalledThreadVm, type InstalledThreadVm } from "./ThreadVmEnrollment.ts";
import { makeExecutorRelayApiClient } from "./executorRelayClient.ts";

const lock = Semaphore.makeUnsafe(1);
const commandRecordName = "workflow-follow-up-publish-command";
const preparedBundleName = "workflow-follow-up-publish-bundle";
const shaSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const PreparedBundle = Schema.fromJsonString(
  Schema.Struct({
    sha: shaSchema,
    baseline: shaSchema,
    oldRemoteSha: Schema.NullOr(shaSchema),
    bundle: Schema.String.check(
      Schema.isMaxLength(Math.ceil(WORKFLOW_VM_FOLLOW_UP_MAX_BUNDLE_BYTES / 3) * 4),
    ),
  }),
);
const decodeBundle = Schema.decodeEffect(PreparedBundle);
const encodeBundle = Schema.encodeEffect(PreparedBundle);
const PendingCommand = Schema.fromJsonString(
  Schema.Struct({
    actorUserId: Schema.String,
    operationId: Schema.String.check(Schema.isUUID()),
    commandId: Schema.String.check(Schema.isUUID()),
    generation: Schema.Int,
    captured: Schema.NullOr(
      Schema.Struct({
        pid: Schema.Int.check(Schema.isGreaterThan(0)),
        identity: Schema.NonEmptyString,
      }),
    ),
  }),
);
type Pending = typeof PendingCommand.Type;
const readCommand = Schema.decodeEffect(PendingCommand);
const encodeCommand = Schema.encodeEffect(PendingCommand);
const failure = (message: string) => new WorkflowVmFollowUpPushError({ message });
const isPushError = Schema.is(WorkflowVmFollowUpPushError);
const isGitError = Predicate.isTagged("WorkflowVmFollowUpGitError");
const decodeCommandBytes = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

interface PushInput {
  readonly jobId: string;
  readonly threadId: string;
  readonly generation: number;
  readonly actorUserId: string;
  readonly operationId: string;
}

const makePushRelay = Effect.fnUntraced(function* (vm: InstalledThreadVm, jobId: string) {
  const url = normalizeSecureRelayUrl(vm.relayUrl);
  const issuer = normalizeSecureRelayUrl(vm.relayIssuer);
  if (!url || !issuer) return yield* failure("This workflow VM cannot publish changes.");
  const client = yield* makeExecutorRelayApiClient({
    url,
    issuer,
    environmentCredential: vm.environmentCredential,
  }).pipe(Effect.provide(FetchHttpClient.layer));
  const params = { environmentId: vm.environmentId, threadId: vm.scope.threadId };
  return {
    environment: client.threadEnvironment,
    call: (
      request: WorkflowVmFollowUpPublishingRequest["request"],
      scope: Pick<Pending, "actorUserId" | "operationId">,
    ) =>
      client.threadEnvironment
        .workflowVmFollowUpPublishing({
          params,
          payload: {
            actorUserId: scope.actorUserId,
            operationId: scope.operationId,
            generation: vm.scope.generation,
            jobId,
            request,
          },
        })
        .pipe(Effect.timeout("25 seconds")),
  };
});

const saveCommand = (secrets: ServerSecretStore["Service"], entry: Pending) =>
  encodeCommand(entry).pipe(
    Effect.flatMap((value) => secrets.set(commandRecordName, new TextEncoder().encode(value))),
  );
const pendingCommand = Effect.flatMap(ServerSecretStore, (secrets) =>
  secrets.get(commandRecordName).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(null),
        onSome: (value) => readCommand(decodeCommandBytes(value)),
      }),
    ),
  ),
);
type PushRelay = Effect.Success<ReturnType<typeof makePushRelay>>;
const settleCommand = (relay: PushRelay, entry: Pending) =>
  relay
    .call({ kind: "stop", commandId: entry.commandId }, entry)
    .pipe(
      Effect.tap(() =>
        Effect.flatMap(ServerSecretStore, (secrets) => secrets.remove(commandRecordName)),
      ),
    );

const stopStoredCommand = Effect.fnUntraced(function* (
  vm: InstalledThreadVm,
  relay: PushRelay,
  entry: Pending,
) {
  if (entry.generation !== vm.scope.generation)
    return yield* failure("The previous VM's GitHub push is still being checked.");
  if (entry.captured !== null) {
    const native = (yield* SetupProcessAdapter).vmPublishing;
    if (!native) return yield* failure("The previous GitHub command could not be inspected.");
    yield* native.stop(entry.captured.pid, entry.captured.identity);
    yield* saveCommand(yield* ServerSecretStore, { ...entry, captured: null });
  }
  yield* settleCommand(relay, entry);
});

/** The running guest can settle a leftover command without an authorized UI session. */
export const recoverWorkflowVmFollowUpPush = lock
  .withPermitsIfAvailable(1)(
    Effect.gen(function* () {
      const entry = yield* pendingCommand;
      if (!entry) return;
      const vm = yield* readInstalledThreadVm();
      if (!vm) return;
      const binding = yield* (yield* WorkflowRunStore).getVmBindingForThread(vm.scope.threadId);
      if (
        !binding ||
        binding.allocationId !== vm.scope.allocationId ||
        binding.generation !== vm.scope.generation
      )
        return;
      const relay = yield* makePushRelay(vm, binding.jobId);
      yield* stopStoredCommand(vm, relay, entry);
    }),
  )
  .pipe(Effect.asVoid);

const pushWorkflowVmFollowUp = (input: PushInput) =>
  lock.withPermits(1)(
    Effect.gen(function* () {
      const vm = yield* readInstalledThreadVm();
      const context = yield* openWorkflowVmFollowUpGit(input);
      const { git, checkout, runtime } = context;
      const native = (yield* SetupProcessAdapter).vmPublishing;
      if (
        !vm ||
        !native?.commandLauncher ||
        vm.environmentId !== runtime.environmentId ||
        vm.scope.allocationId !== runtime.allocationId ||
        vm.scope.threadId !== runtime.threadId ||
        vm.scope.generation !== runtime.generation ||
        vm.scope.repositoryId !== runtime.repositoryId ||
        vm.operationId !== runtime.operationId
      )
        return yield* failure("This workflow VM cannot publish changes.");
      const secrets = yield* ServerSecretStore;
      const relay = yield* makePushRelay(vm, runtime.jobId);
      const call = (
        request: WorkflowVmFollowUpPublishingRequest["request"],
        scope: Pick<Pending, "actorUserId" | "operationId"> = input,
      ) => relay.call(request, scope);
      const restoreRemotePrerequisite = Effect.fnUntraced(function* (sha: string | null) {
        if (sha === null) return;
        const commit = yield* git.git(["cat-file", "-e", `${sha}^{commit}`], {
          allowNonZero: true,
        });
        if (commit.code === 0) return;
        // A restored disk can predate a previous push's import into the
        // private Git database. The saved worktree still has the user's commit.
        const canonicalKey = context.run.repositoryCanonicalKey;
        const token = yield* relay.environment
          .mintRepositoryToken({
            params: { environmentId: runtime.environmentId, threadId: runtime.threadId },
            payload: { generation: runtime.generation, canonicalKey },
          })
          .pipe(Effect.timeout("15 seconds"));
        if (token.canonicalKey !== canonicalKey)
          return yield* failure("The workflow's GitHub repository changed.");
        yield* git.git(
          ["fetch", "--no-tags", "--no-write-fetch-head", "--", `https://${canonicalKey}.git`, sha],
          { token: Redacted.make(token.token) },
        );
        yield* git.git(["cat-file", "-e", `${sha}^{commit}`]);
      });
      const previous = yield* pendingCommand;
      if (previous) yield* stopStoredCommand(vm, relay, previous);
      const baseline = yield* readWorkflowVmFollowUpGitBaseline(context);
      const headSha = yield* checkout(["rev-parse", "--verify", "HEAD^{commit}"]);
      let result = yield* call({ kind: "read", headSha });
      if (result.kind === "prepare") {
        const sha = result.sha ?? headSha;
        const oldRemoteSha = result.oldRemoteSha;
        yield* restoreRemotePrerequisite(oldRemoteSha);
        const prior = yield* secrets.get(preparedBundleName);
        const prepared = Option.isNone(prior)
          ? null
          : yield* decodeBundle(decodeCommandBytes(prior.value));
        const bundle =
          prepared?.sha === sha &&
          prepared.baseline === baseline.sha &&
          prepared.oldRemoteSha === oldRemoteSha
            ? prepared.bundle
            : yield* exportWorkflowVmFollowUpBundle(context, sha, baseline.sha, oldRemoteSha);
        yield* verifyWorkflowVmFollowUpBundle(context, {
          bundle,
          sha,
          baseline: baseline.sha,
          oldRemoteSha,
        });
        const bytes = yield* encodeBundle({ bundle, sha, baseline: baseline.sha, oldRemoteSha });
        yield* secrets.set(preparedBundleName, new TextEncoder().encode(bytes));
        result = yield* call({ kind: "prepare", baseline, sha, oldRemoteSha, bundle });
      }
      yield* secrets.remove(preparedBundleName);
      if (result.kind === "result") return result.result;
      if (
        result.kind !== "ready" ||
        result.result.branch !== baseline.branch ||
        result.canonicalKey !== context.run.repositoryCanonicalKey
      )
        return yield* failure("The workflow push could not be prepared.");

      const receipt = result.result;
      const oldRemoteSha = result.oldRemoteSha;
      yield* restoreRemotePrerequisite(oldRemoteSha);
      yield* verifyWorkflowVmFollowUpBundle(context, {
        bundle: result.bundle,
        sha: receipt.commitSha,
        baseline: baseline.sha,
        oldRemoteSha,
      });
      const executable = yield* native.commandLauncher;
      let entry: Pending = {
        actorUserId: input.actorUserId,
        operationId: receipt.operationId,
        commandId: NodeCrypto.randomUUID(),
        generation: runtime.generation,
        captured: null,
      };
      const commandId = entry.commandId;
      const pending = (detail: string): WorkflowVmFollowUpPushResult => ({
        ...receipt,
        status: "pending",
        detail,
      });
      return yield* Effect.gen(function* () {
        // Record the command before the relay can issue write authority. A restarted
        // guest must settle this same command before asking for another credential.
        yield* saveCommand(secrets, entry);
        const authorization = yield* call({ kind: "arm", commandId }, entry);
        if (authorization.kind !== "credential") {
          yield* secrets.remove(commandRecordName);
          if (authorization.kind === "result") return authorization.result;
          return pending("The relay is checking the previous GitHub push.");
        }
        const ownedError = () =>
          new ProcessOwnershipError({
            command: "workflow follow-up push",
            argumentCount: 0,
            cause: "The publishing command owner could not be confirmed.",
          });
        let stopped = false;
        const owner: OwnedCommand = {
          executable,
          capture: (pid) =>
            Effect.gen(function* () {
              const captured = yield* native.inspect(pid);
              if (!captured.owned || !captured.identity) return yield* ownedError();
              entry = { ...entry, captured: { pid, identity: captured.identity } };
              yield* saveCommand(secrets, entry);
            }).pipe(Effect.mapError(ownedError)),
          arm: Effect.gen(function* () {
            if (!entry.captured) return yield* ownedError();
            const confirmed = yield* call({ kind: "confirm", commandId }, entry);
            if (confirmed.kind !== "ok") return yield* ownedError();
            yield* native.arm(entry.captured.pid, entry.captured.identity);
          }).pipe(Effect.mapError(ownedError)),
          completed: () => Effect.void,
          stop: Effect.gen(function* () {
            if (stopped) return;
            if (entry.captured) {
              yield* native.stop(entry.captured.pid, entry.captured.identity);
              entry = { ...entry, captured: null };
              yield* saveCommand(secrets, entry);
            }
            stopped = true;
          }).pipe(Effect.mapError(ownedError)),
        };
        const publish = yield* git
          .push(
            authorization.token,
            `refs/heads/${receipt.branch}`,
            oldRemoteSha,
            receipt.commitSha,
          )
          .pipe(
            Effect.provideService(CurrentWorkflowCommand, Effect.succeed(owner)),
            Effect.result,
          );
        if (!stopped && publish._tag === "Failure" && entry.captured !== null)
          return pending("The previous GitHub command is still being checked.");
        const observed = yield* settleCommand(relay, entry);
        return observed.kind === "result"
          ? observed.result
          : pending("GitHub has not confirmed the workflow commit yet.");
      }).pipe(
        // A disconnected renderer leaves the protected command receipt. The next
        // attempt must confirm the old native process stopped before retrying.
        Effect.orElseSucceed(() => pending("GitHub has not confirmed the workflow commit yet.")),
      );
    }).pipe(
      Effect.mapError((error) =>
        isPushError(error) || isGitError(error)
          ? failure(error.message)
          : failure("The workflow branch could not be checked. Try again."),
      ),
    ),
  );

interface Publisher {
  readonly push: (
    input: PushInput,
  ) => Effect.Effect<WorkflowVmFollowUpPushResult, WorkflowVmFollowUpPushError>;
  readonly prepareBaseline: (
    input: Parameters<typeof installWorkflowVmFollowUpGitBaseline>[0],
  ) => Effect.Effect<
    Effect.Success<ReturnType<typeof installWorkflowVmFollowUpGitBaseline>>,
    WorkflowVmFollowUpGitError
  >;
}
export class WorkflowVmFollowUpPublisher extends Context.Reference<Publisher>(
  "t3/relay/WorkflowVmFollowUpPublisher",
  {
    defaultValue: () => ({
      push: () => Effect.fail(failure("This workflow VM cannot publish changes.")),
      prepareBaseline: () =>
        Effect.fail(
          new WorkflowVmFollowUpGitError({
            message: "The workflow VM Git baseline is unavailable.",
          }),
        ),
    }),
  },
) {
  static readonly layer = Layer.effect(
    WorkflowVmFollowUpPublisher,
    Effect.gen(function* () {
      const deps = yield* Effect.context<
        | Effect.Services<ReturnType<typeof pushWorkflowVmFollowUp>>
        | Effect.Services<ReturnType<typeof installWorkflowVmFollowUpGitBaseline>>
      >();
      return {
        push: (input: PushInput) => pushWorkflowVmFollowUp(input).pipe(Effect.provide(deps)),
        prepareBaseline: (input: Parameters<typeof installWorkflowVmFollowUpGitBaseline>[0]) =>
          installWorkflowVmFollowUpGitBaseline(input).pipe(Effect.provide(deps)),
      };
    }),
  );
}
