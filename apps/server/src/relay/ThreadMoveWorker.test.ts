import * as HttpClient from "effect/unstable/http/HttpClient";
import { makeThreadLocalEnrollmentWorker } from "./ThreadLocalEnrollmentWorker.ts";
import {
  RelayOrganizationId,
  RelayRepositoryId,
  ThreadTransferArtifactManifest,
} from "@t3tools/contracts/relay";
import * as Option from "effect/Option";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ThreadPromptQueue,
  type ServerProvider,
  type ProviderSession,
  TurnId,
  TerminalProcessExitError,
} from "@t3tools/contracts";
import type { RelayThreadMove, ThreadMoveProgressReport } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ThreadBackgroundLivenessService } from "../orchestration/ThreadBackgroundLiveness.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  layer as SessionLayer,
  ProviderSessionRuntimeRepository,
} from "../persistence/ProviderSessionRuntime.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { makeThreadMoveTransferIntent } from "../persistence/ThreadMoveTransferIntent.ts";
import { makeCheckoutCapture } from "../persistence/CheckoutCapture.ts";
import { ProcessRunner, layer as RunnerLayer } from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { makeThreadHistorySync } from "./ThreadHistorySync.ts";
import { ThreadMoveError, type ThreadMoveTransport } from "./ThreadMoveTransport.ts";
import { makeThreadMoveWorker } from "./ThreadMoveWorker.ts";
import { ThreadVmProviderAuth, makeThreadVmProviderAuth } from "./ThreadVmProviderAuth.ts";
import { ProviderAuthService } from "../provider/Services/ProviderAuthService.ts";
import {
  ThreadVmCodexAuthContext,
  ThreadVmCodexAuthSourceError,
} from "./ThreadVmCodexAuthSource.ts";
import { THREAD_VM_IDENTITY_SECRET } from "./ThreadVmEnrollment.ts";
import { VmWorkloadTracking } from "../vmWorkloadCommand.ts";
import { ThreadExecution } from "./ThreadExecution.ts";
import { makeThreadExecutionRelay } from "./ThreadExecutionRelay.ts";

const at = "2026-10-07T00:00:00Z",
  threadId = ThreadId.make("move-thread"),
  instanceId = ProviderInstanceId.make("codex");
const sourceId = EnvironmentId.make("source"),
  destinationId = EnvironmentId.make("destination"),
  projectId = ProjectId.make("project");
const driverKind = ProviderDriverKind.make("codex"),
  unused = () => Effect.die("Unexpected provider call");
const status: ServerProvider = {
  instanceId,
  driver: driverKind,
  enabled: true,
  installed: true,
  version: "0.159.3",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: at,
  models: [],
  slashCommands: [],
  skills: [],
};
const instance: ProviderInstance = {
  instanceId,
  driverKind,
  continuationIdentity: { driverKind, continuationKey: "test" },
  displayName: undefined,
  enabled: true,
  snapshot: {
    getSnapshot: Effect.succeed(status),
    refresh: Effect.succeed(status),
    resolveMaintenance: unused,
    streamChanges: Stream.empty,
    applyUsageLimits: unused,
  },
  textGeneration: {
    generateCommitMessage: unused,
    generatePrContent: unused,
    generateBranchName: unused,
    generateThreadTitle: unused,
    generateApprovalVerdict: unused,
  },
  adapter: {
    provider: driverKind,
    capabilities: { sessionModelSwitch: "in-session" },
    hasSession: () => Effect.succeed(false),
    probeSession: unused,
    startSession: unused,
    stopSession: unused,
    sendTurn: unused,
    interruptTurn: unused,
    respondToRequest: unused,
    respondToUserInput: unused,
    listSessions: unused,
    readThread: unused,
    rollbackThread: unused,
    stopAll: unused,
    streamEvents: Stream.empty,
  },
};
const environment = (root: string) =>
  Layer.mergeAll(OrchestrationLayerLive, SessionLayer).pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      Layer.effect(
        ThreadExecution,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return makeThreadExecutionRelay(
            yield* SqlClient.SqlClient,
            {
              admit: () => Effect.succeed({ completed: false, newlyAdmitted: true }),
              complete: () => Effect.void,
            },
            undefined,
            { canonicalizeRoot: fs.realPath },
          );
        }),
      ).pipe(Layer.provide(SqlitePersistenceMemory)),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), root)),
    Layer.provideMerge(RunnerLayer),
    Layer.provideMerge(
      Layer.mock(ProviderInstanceRegistry)({ getInstance: () => Effect.succeed(instance) }),
    ),
    Layer.provideMerge(Layer.mock(ProviderService)({ listSessions: () => Effect.succeed([]) })),
    Layer.provideMerge(Layer.mock(ServerSecretStore)({ get: () => Effect.succeed(Option.none()) })),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(sourceId) }),
    ),
    Layer.provideMerge(Layer.mock(TerminalManager)({ close: () => Effect.void })),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected relay repository request")),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.fresh,
  );
const decodeQueue = Schema.decodeEffect(Schema.fromJsonString(ThreadPromptQueue));
const encodeMoveJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeTransferIndex = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ThreadTransferArtifactManifest),
);
const queue = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    state: string;
  }>`SELECT state_json AS state FROM projection_thread_prompt_queues WHERE thread_id=${threadId}`;
  return yield* decodeQueue(row!.state);
});
const moveDetail = queue.pipe(
  Effect.map((state) => {
    const head = state.entries[0];
    return head?.kind === "move" ? head.detail : undefined;
  }),
);

for (const lost of [
  "published",
  "recovery-publish",
  "recovery-ready",
  "recovery-sticky-failure",
  "recovery-two-failures",
  "destination-awaits-recovery",
  "parallel-transfer",
  "upload",
  "packed-v2",
  "encoding-health-retry",
  "encoding-cancel-fresh",
  "encoding-cancel-v2",
  "encoding-wait",
  "encoding-change",
  "encoding-missing",
  "ready",
  "commit",
  "activate",
  "cancel-setup",
  "cancel-edit",
  "cancel-uncertain",
  "cancel-report",
  "destination-auth",
  "vm-auth-personal",
  "vm-auth-organization",
  "source-export",
  "shared-active",
  "shared-ready-no-git",
  "capture-cancel",
  "capture-failure",
  "capture-stop-failure",
  "capture-upload-blocked",
  "capture-retargeted",
  "capture-retargeted-alias",
  "capture-retargeted-git",
  "capture-rename-recovery",
  "capture-rename-cancel",
  "sealed-missing",
  "enroll-prepare",
  "enroll-receipts",
  "enroll-confirm",
  "enroll-cancel-prepare",
  "source-retargeted-project",
  "destination-wrong-repository",
  "destination-repointed-project",
  "destination-nested-project",
  "destination-unconfirmed-repository",
  "destination-repointed-during-download",
  "destination-ready-receipt",
  "destination-baseline-receipt",
] as const)
  it.effect(
    lost.startsWith("vm-auth-")
      ? `preserves installed receipts while ${lost} waits and resumes without replay after restart`
      : lost === "published"
        ? "keeps a published move frozen without uploading the archive again after a restart"
        : lost === "recovery-ready"
          ? "repairs the frozen recovery save before committing an already-ready destination"
          : lost === "recovery-sticky-failure"
            ? "retries the missing frozen recovery save despite a retained move failure"
            : lost === "destination-awaits-recovery"
              ? "waits after destination readiness until the frozen recovery save is verified"
              : lost === "parallel-transfer"
                ? "moves files in bounded parallel transfers and publishes only after every upload completes"
                : lost === "commit"
                  ? "activates a verified checkout after a lost commit reply despite changed repository metadata"
                  : lost === "source-retargeted-project"
                    ? "retains the exact queued project when the relay returns another destination"
                    : lost === "shared-active" || lost === "shared-ready-no-git"
                      ? "drains canonical checkout siblings and checkpoints before sealing, then reuses the archive"
                      : lost === "capture-cancel"
                        ? "releases a draining checkout before a lost cancellation reply"
                        : lost === "capture-failure"
                          ? "releases a settled capture failure while the moving thread stays frozen"
                          : lost === "capture-stop-failure"
                            ? "releases a draining checkout after an uncertain terminal stop"
                            : lost === "capture-upload-blocked"
                              ? "releases sibling admission while the sealed source upload waits"
                              : lost.startsWith("capture-retargeted")
                                ? `rejects ${lost} after capture admission before exporting`
                                : lost.startsWith("capture-rename")
                                  ? `syncs the recovered archive rename before releasing ${lost}`
                                  : lost === "sealed-missing"
                                    ? "refuses to recapture a missing sealed source archive after restart"
                                    : lost === "destination-wrong-repository" ||
                                        lost === "destination-repointed-project" ||
                                        lost === "destination-nested-project" ||
                                        lost === "destination-unconfirmed-repository" ||
                                        lost === "destination-repointed-during-download"
                                      ? `blocks ${lost} before installing a checkout or changing local files`
                                      : `moves the complete workspace and queued prompt once despite a lost ${lost} reply`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem,
            path = yield* Path.Path,
            runner = yield* ProcessRunner;
          const root = yield* fs.realPath(
            yield* fs.makeTempDirectoryScoped({ prefix: "move-worker-" }),
          );
          const src = path.join(root, "source"),
            dst = path.join(root, "destination");
          const postInstallAuthLoss = lost.startsWith("vm-auth-");
          const targetProjectId = postInstallAuthLoss
            ? ProjectId.make(`vm:${threadId}`)
            : projectId;
          const validationFailure =
            lost === "destination-wrong-repository" ||
            lost === "destination-repointed-project" ||
            lost === "destination-nested-project" ||
            lost === "destination-unconfirmed-repository" ||
            lost === "destination-repointed-during-download";
          const git = (cwd: string, args: ReadonlyArray<string>) =>
            runner
              .run({
                command: "git",
                args: ["-c", "core.hooksPath=/dev/null", ...args],
                cwd,
                env: {
                  GIT_CONFIG_GLOBAL: "/dev/null",
                  GIT_CONFIG_NOSYSTEM: "1",
                  GIT_CONFIG_COUNT: "0",
                  GIT_AUTHOR_NAME: "Test",
                  GIT_AUTHOR_EMAIL: "test@localhost",
                  GIT_COMMITTER_NAME: "Test",
                  GIT_COMMITTER_EMAIL: "test@localhost",
                },
              })
              .pipe(Effect.tap((result) => Effect.sync(() => expect(result.code).toBe(0))));
          yield* fs.makeDirectory(src);
          yield* git(src, ["init", "-b", "main"]);
          yield* git(src, ["remote", "add", "origin", "https://github.com/test/enrollment.git"]);
          yield* fs.writeFileString(path.join(src, "README"), "committed\n");
          if (lost.startsWith("cancel-"))
            yield* fs.writeFileString(
              path.join(src, "t3.json"),
              yield* encodeMoveJson({
                scripts: [
                  {
                    id: "setup",
                    name: "Setup",
                    runOnWorktreeCreate: true,
                    command:
                      "mkdir node_modules; printf deps > node_modules/proof; printf 'setup edit\\n' > README; printf created > setup-count; exit 7",
                  },
                ],
              }),
            );
          yield* git(src, ["add", "."]);
          yield* git(src, ["commit", "-m", "base"]);
          yield* git(root, ["clone", "--no-local", src, dst]);
          yield* git(dst, [
            "remote",
            "set-url",
            "origin",
            "https://github.com/test/enrollment.git",
          ]);
          yield* fs.writeFileString(path.join(src, "README"), "uncommitted work\n");
          if (lost === "parallel-transfer")
            for (let i = 0; i < 8; i++)
              yield* fs.writeFileString(path.join(src, `dirty-${i}`), `unsaved work ${i}\n`);
          const uploadGate = yield* Deferred.make<void>();
          const uploadEntered = yield* Deferred.make<void>();
          const uploadRelease = yield* Deferred.make<void>();
          const downloadGate = yield* Deferred.make<void>();
          let activeUploads = 0,
            maximumUploads = 0,
            uploadStarts = 0,
            activeDownloads = 0,
            maximumDownloads = 0,
            downloadStarts = 0;
          const uploads = new Map<string, Uint8Array>();
          let remote: RelayThreadMove | undefined,
            lostReply = false,
            commits = 0,
            commitAttempts = 0;
          let formatReads = 0,
            selections = 0,
            vmBegins = 0;
          const destinationProgress: ThreadMoveProgressReport[] = [];
          const downloadedArtifacts: string[] = [];
          const packedEncoding = [
            "packed-v2",
            "encoding-health-retry",
            "encoding-wait",
            "encoding-change",
            "encoding-missing",
          ].includes(lost);
          const failure = () => new ThreadMoveError({ threadId, detail: "Lost relay reply" });
          const current = Effect.suspend(() =>
            remote ? Effect.succeed(remote) : Effect.fail(failure()),
          );
          const transport: ThreadMoveTransport = {
            sourceFormats: () =>
              Effect.gen(function* () {
                formatReads++;
                if (lost.startsWith("encoding-cancel-"))
                  return yield* Effect.die("Cancellation must not discover a new encoding");
                if (lost === "encoding-health-retry" && formatReads === 1) return yield* failure();
                return packedEncoding && (formatReads === 1 || lost === "encoding-health-retry")
                  ? (["launchpad-thread-chunks-v1", "launchpad-thread-chunks-v2"] as const)
                  : (["launchpad-thread-chunks-v1"] as const);
              }),
            selectEncoding: () =>
              Effect.sync(() => {
                selections++;
                if (lost === "encoding-missing") {
                  const missing = { ...remote! };
                  delete missing.transferEncodingPolicy;
                  return (remote = missing);
                }
                return (remote = {
                  ...remote!,
                  transferEncodingPolicy:
                    lost === "encoding-wait" && selections === 1 ? null : "workspace-raw-v2-8MiB",
                });
              }),
            pending: () => Effect.succeed({ entries: [], next: null }),
            beginVm: (owner, input) =>
              Effect.sync(() => {
                expect(lost.startsWith("encoding-cancel-")).toBe(true);
                expect(input.cancelBeforeStart).toBe(true);
                expect(input.sourceThreadTransferFormats).toEqual(
                  lost === "encoding-cancel-v2"
                    ? ["launchpad-thread-chunks-v1", "launchpad-thread-chunks-v2"]
                    : undefined,
                );
                vmBegins++;
                remote = {
                  manifestArtifactId: null,
                  threadId,
                  operationId: owner.operationId,
                  actorUserId: input.actorUserId,
                  sourceEnvironmentId: sourceId,
                  expectedGeneration: 1,
                  destinationEnvironmentId: destinationId,
                  destinationProjectId: projectId,
                  phase: "aborted",
                  sourceCursor: null,
                  manifestSha256: null,
                };
                return { status: "accepted" as const, move: remote };
              }),
            begin: (owner, input) =>
              Effect.sync(
                () =>
                  (remote ??= {
                    manifestArtifactId: null,
                    threadId,
                    operationId: owner.operationId,
                    actorUserId: input.actorUserId,
                    sourceEnvironmentId: sourceId,
                    expectedGeneration: 1,
                    destinationEnvironmentId: destinationId,
                    destinationProjectId:
                      lost === "source-retargeted-project"
                        ? ProjectId.make("sibling")
                        : targetProjectId,
                    ...(lost === "destination-unconfirmed-repository"
                      ? {}
                      : {
                          repositoryCanonicalKeys: [
                            "github.com/test/historical",
                            "github.com/test/enrollment",
                          ],
                        }),
                    phase: "preparing",
                    sourceCursor: null,
                    manifestSha256: null,
                    ...(packedEncoding ? { transferEncodingPolicy: null } : {}),
                  }),
              ),
            get: () => current,
            progress: (owner, report) =>
              Effect.sync(() => {
                if (owner.environmentId === destinationId) destinationProgress.push(report);
                remote = {
                  ...remote!,
                  progress: [
                    ...(remote?.progress ?? []).filter(
                      (snapshot) => snapshot.environmentId !== owner.environmentId,
                    ),
                    {
                      ...report,
                      operationId: owner.operationId,
                      threadId,
                      environmentId: owner.environmentId,
                      generation: owner.generation,
                      participant: owner.environmentId === sourceId ? "source" : "destination",
                      updatedAt: at,
                    },
                  ],
                };
                if (remote.participantStates?.length)
                  remote = {
                    ...remote,
                    failureDetail:
                      remote.participantStates.find(
                        (participant) =>
                          participant.failure &&
                          participant.failure.attempt >= participant.resolvedBeforeAttempt &&
                          participant.failure.attempt >=
                            (remote?.progress?.find(
                              (snapshot) => snapshot.environmentId === participant.environmentId,
                            )?.attempt ?? 0),
                      )?.failure?.detail ?? null,
                  };
                return { accepted: true };
              }),
            failed: (owner, detail, attempt) =>
              lost === "cancel-report"
                ? Effect.fail(failure())
                : Effect.sync(() => {
                    expect(["preparing", "frozen", "ready"]).toContain(remote?.phase);
                    return (remote = {
                      ...remote!,
                      failureDetail:
                        attempt === undefined ? (remote!.failureDetail ?? detail) : detail,
                      ...(attempt === undefined
                        ? {}
                        : {
                            participantStates: [
                              ...(remote?.participantStates ?? []).filter(
                                (state) => state.environmentId !== owner.environmentId,
                              ),
                              {
                                environmentId: owner.environmentId,
                                generation: owner.generation,
                                resolvedBeforeAttempt: 0,
                                failure: { attempt, detail, reportedAt: at },
                              },
                            ],
                          }),
                    });
                  }),
            freeze: (_owner, input) =>
              Effect.sync(
                () => (remote = { ...remote!, ...input, phase: "frozen", failureDetail: null }),
              ),
            upload: (owner, file, body) =>
              Effect.gen(function* () {
                activeUploads++;
                maximumUploads = Math.max(maximumUploads, activeUploads);
                uploadStarts++;
                if (lost === "capture-upload-blocked") {
                  yield* Deferred.succeed(uploadEntered, undefined);
                  yield* Deferred.await(uploadRelease);
                }
                if (lost === "parallel-transfer" && uploadStarts <= 4) {
                  expect(remote?.manifestArtifactId).toBeNull();
                  if (uploadStarts === 4) yield* Deferred.succeed(uploadGate, undefined);
                  yield* Deferred.await(uploadGate);
                }
                return yield* body.pipe(
                  Stream.runCollect,
                  Effect.mapError(failure),
                  Effect.flatMap((parts) =>
                    Effect.gen(function* () {
                      const bytes = Buffer.concat(parts);
                      expect(bytes.length).toBe(file.sizeBytes);
                      expect(NodeCrypto.createHash("sha256").update(bytes).digest("hex")).toBe(
                        file.sha256,
                      );
                      if (uploads.has(file.artifactId))
                        expect(bytes).toEqual(Buffer.from(uploads.get(file.artifactId)!));
                      uploads.set(file.artifactId, bytes);
                      if (
                        ["upload", "sealed-missing", "packed-v2", "encoding-change"].includes(
                          lost,
                        ) &&
                        !lostReply
                      ) {
                        lostReply = true;
                        return yield* failure();
                      }
                      return {
                        ...file,
                        threadId: ThreadId.make(owner.threadId),
                        state: "complete" as const,
                      };
                    }),
                  ),
                );
              }).pipe(Effect.ensuring(Effect.sync(() => activeUploads--))),
            publish: (_owner, id) =>
              Effect.gen(function* () {
                expect(activeUploads).toBe(0);
                remote = { ...remote!, manifestArtifactId: id, recoveryVerified: false };
                if (
                  (lost === "recovery-publish" ||
                    lost === "recovery-ready" ||
                    lost === "recovery-sticky-failure" ||
                    lost === "recovery-two-failures") &&
                  !lostReply
                ) {
                  lostReply = true;
                  return yield* failure();
                }
                remote = { ...remote, recoveryVerified: true };
                return { manifestArtifactId: id, artifactCount: uploads.size };
              }),
            artifact: (_owner, id) => {
              downloadedArtifacts.push(id);
              const bytes = uploads.get(id);
              if (!bytes) return Effect.fail(failure());
              if (
                lost === "destination-repointed-during-download" &&
                id === remote?.manifestArtifactId
              )
                return git(dst, [
                  "remote",
                  "set-url",
                  "origin",
                  "https://github.com/test/other.git",
                ]).pipe(Effect.mapError(failure), Effect.as(Stream.succeed(bytes)));
              if (lost !== "parallel-transfer" || id === remote?.manifestArtifactId)
                return Effect.succeed(Stream.succeed(bytes));
              return Effect.succeed(
                Stream.fromEffect(
                  Effect.gen(function* () {
                    activeDownloads++;
                    maximumDownloads = Math.max(maximumDownloads, activeDownloads);
                    downloadStarts++;
                    if (downloadStarts <= 4) {
                      if (downloadStarts === 4) yield* Deferred.succeed(downloadGate, undefined);
                      yield* Deferred.await(downloadGate);
                    }
                    return bytes;
                  }).pipe(Effect.ensuring(Effect.sync(() => activeDownloads--))),
                ),
              );
            },
            ready: () =>
              Effect.gen(function* () {
                remote = { ...remote!, phase: "ready", failureDetail: null };
                if (lost === "ready" && !lostReply) {
                  lostReply = true;
                  return yield* failure();
                }
                return remote;
              }),
            commit: () =>
              Effect.gen(function* () {
                commitAttempts++;
                if (remote!.recoveryVerified !== true) return yield* failure();
                if (remote!.phase !== "committed" && remote!.phase !== "completed") {
                  commits++;
                  remote = { ...remote!, phase: "committed" };
                }
                if (lost === "commit" && !lostReply) {
                  lostReply = true;
                  return yield* failure();
                }
                return remote!;
              }),
            activate: () =>
              Effect.gen(function* () {
                remote = { ...remote!, phase: "completed" };
                if (lost === "activate" && !lostReply) {
                  lostReply = true;
                  return yield* failure();
                }
                return remote;
              }),
            abort: () =>
              lost === "capture-cancel"
                ? Effect.fail(failure())
                : Effect.sync(() => (remote = { ...remote!, phase: "aborting" })),
            removed: () => Effect.sync(() => (remote = { ...remote!, phase: "aborted" })),
          };
          yield* Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService,
              sql = yield* SqlClient.SqlClient,
              fences = makeThreadExecutionFence(sql);
            const sourceBinding =
              lost === "capture-retargeted-alias" ? path.join(root, "source-alias") : src;
            if (sourceBinding !== src) yield* fs.symlink(src, sourceBinding);
            yield* engine.dispatch({
              type: "project.create",
              commandId: CommandId.make("source-project"),
              projectId,
              title: "Source",
              workspaceRoot: sourceBinding,
              createdAt: at,
            });
            yield* engine.dispatch({
              type: "thread.create",
              commandId: CommandId.make("source-thread"),
              threadId,
              projectId,
              title: "Move",
              modelSelection: { instanceId, model: "gpt-5" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "main",
              worktreePath: null,
              createdAt: at,
            });
            yield* engine.dispatch({
              type: "thread.move.enqueue",
              commandId: CommandId.make("queue-move"),
              threadId,
              messageId: MessageId.make("move"),
              destination: lost.startsWith("encoding-cancel-")
                ? { kind: "vm" }
                : { kind: "environment", environmentId: destinationId, projectId: targetProjectId },
              author: { userId: "owner", displayName: "Owner", imageUrl: null },
              createdAt: at,
            });
            yield* engine.dispatch({
              type: "thread.prompt.enqueue",
              commandId: CommandId.make("queue-prompt"),
              threadId,
              message: {
                messageId: MessageId.make("prompt"),
                text: "Run after moving",
                attachments: [],
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: at,
            });
            const enrolled = {
              threadId,
              projectId,
              environmentId: sourceId,
              relayUrl: "https://relay.test",
              generation: 1,
              operationId: "enroll",
            };
            if (!lost.startsWith("enroll-")) {
              yield* fences.prepare(enrolled);
              yield* fences.activate(enrolled);
            }
            const history = makeThreadHistorySync(sql, engine, {
              append: () => Effect.void,
              confirmThrough: () => Effect.void,
            });
            const commands = {
              synchronize: () =>
                Effect.gen(function* () {
                  if (remote?.phase === "aborted") {
                    const head = (yield* queue).entries[0];
                    if (head?.kind === "move" && head.state !== "cancelling")
                      yield* engine.dispatch({
                        type: "thread.move.cancel",
                        commandId: CommandId.make("cancel"),
                        threadId,
                        messageId: head.messageId,
                        expectedRevision: head.revision,
                        createdAt: at,
                      });
                  }
                }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
            };
            if (lost.startsWith("enroll-")) {
              let phase: "preparing" | "active" = "preparing",
                baseline: number | null = null,
                receiptCount: number | null = null;
              const receiptIds = new Set<string>();
              let replies = 0,
                abortReplyLost = false;
              const initialTransport = {
                abort: (
                  owner: import("./ThreadHistorySync.ts").ThreadHistoryOwner,
                  input: import("@t3tools/contracts/relay").RelayThreadLocalEnrollmentRequest,
                ) =>
                  Effect.gen(function* () {
                    if (lost !== "enroll-cancel-prepare")
                      return yield* Effect.die("Unexpected enrollment cancellation");
                    if (!abortReplyLost) {
                      abortReplyLost = true;
                      return yield* failure();
                    }
                    return {
                      ...input,
                      threadId,
                      environmentId: EnvironmentId.make(owner.environmentId),
                      outcome: "aborted" as const,
                    };
                  }),
                prepare: (
                  owner: import("./ThreadHistorySync.ts").ThreadHistoryOwner,
                  input: import("@t3tools/contracts/relay").RelayThreadLocalEnrollmentRequest,
                ) =>
                  Effect.gen(function* () {
                    replies++;
                    if (
                      (lost === "enroll-prepare" || lost === "enroll-cancel-prepare") &&
                      !lostReply
                    ) {
                      lostReply = true;
                      return yield* failure();
                    }
                    return {
                      threadId,
                      operationId: input.operationId,
                      phase,
                      sourceSequence: baseline,
                      receiptCount,
                      placement: {
                        threadId,
                        environmentId: sourceId,
                        projectId,
                        generation: 1,
                        operationId: phase === "preparing" ? input.operationId : null,
                        organizationId: RelayOrganizationId.make("org"),
                        repositoryId: RelayRepositoryId.make("repo"),
                        ownerUserId: "owner",
                      },
                    };
                  }),
                receipts: (
                  _owner: import("./ThreadHistorySync.ts").ThreadHistoryOwner,
                  input: import("@t3tools/contracts/relay").RelayThreadLocalEnrollmentReceiptRequest,
                ) =>
                  Effect.gen(function* () {
                    for (const receipt of input.receipts) receiptIds.add(receipt.commandId);
                    if (lost === "enroll-receipts" && !lostReply) {
                      lostReply = true;
                      return yield* failure();
                    }
                    return { ok: true as const };
                  }),
                confirm: (
                  _owner: import("./ThreadHistorySync.ts").ThreadHistoryOwner,
                  input: { operationId: string; sourceSequence: number; receiptCount: number },
                ) =>
                  Effect.gen(function* () {
                    phase = "active";
                    baseline = input.sourceSequence;
                    receiptCount = input.receiptCount;
                    expect(receiptIds.size).toBe(receiptCount);
                    if (lost === "enroll-confirm" && !lostReply) {
                      lostReply = true;
                      return yield* failure();
                    }
                    return {
                      threadId,
                      operationId: input.operationId,
                      phase,
                      sourceSequence: baseline,
                      receiptCount,
                      placement: {
                        threadId,
                        environmentId: sourceId,
                        projectId,
                        generation: 1,
                        operationId: null,
                        organizationId: RelayOrganizationId.make("org"),
                        repositoryId: RelayRepositoryId.make("repo"),
                        ownerUserId: "owner",
                      },
                    };
                  }),
              };
              let initial = yield* makeThreadLocalEnrollmentWorker(initialTransport, history);
              expect(yield* fences.get(threadId)).toBeNull();
              expect((yield* Effect.flip(initial.synchronize(threadId, enrolled)))._tag).toBe(
                "ThreadMoveError",
              );
              if (lost === "enroll-cancel-prepare") {
                const head = (yield* queue).entries[0]!;
                yield* engine.dispatch({
                  type: "thread.move.cancel",
                  threadId,
                  commandId: CommandId.make("initial-cancel"),
                  messageId: head.messageId,
                  expectedRevision: head.revision,
                  createdAt: at,
                });
                expect((yield* Effect.flip(initial.synchronize(threadId, enrolled)))._tag).toBe(
                  "ThreadMoveError",
                );
                expect((yield* queue).entries[0]?.state).toBe("cancelling");
                initial = yield* makeThreadLocalEnrollmentWorker(initialTransport, history);
                expect(yield* initial.synchronize(threadId, enrolled)).toBe(false);
                expect(yield* fences.get(threadId)).toBeNull();
                yield* fences.assertDirectClientAllowed(threadId);
                expect((yield* queue).entries.map((e) => e.messageId)).toEqual(["prompt"]);
                expect(remote).toBeUndefined();
                expect(replies).toBe(1);
                expect(commits).toBe(0);
                expect(yield* fs.readFileString(path.join(src, "README"))).toBe(
                  "uncommitted work\n",
                );
                return;
              }
              if (lost !== "enroll-prepare") {
                expect((yield* fences.get(threadId))?.phase).toBe("frozen");
                yield* Effect.flip(fences.assertDirectClientAllowed(threadId));
              }
              initial = yield* makeThreadLocalEnrollmentWorker(initialTransport, history);
              expect(yield* initial.synchronize(threadId, enrolled)).toBe(true);
              expect((yield* fences.get(threadId))?.phase).toBe("active");
              expect(yield* initial.synchronize(threadId, enrolled)).toBe(true);
              expect(replies).toBe(2);
              expect((yield* queue).entries.map((entry) => entry.messageId)).toEqual([
                "move",
                "prompt",
              ]);
            }
            let source = yield* makeThreadMoveWorker(transport, history, commands);
            const sourceQueue = queue.pipe(Effect.provideService(SqlClient.SqlClient, sql));
            const captures = makeCheckoutCapture(sql);
            const execution = yield* ThreadExecution;
            const sibling = ThreadId.make("sibling");
            if (lost.startsWith("encoding-cancel-")) {
              const pending = yield* queue;
              const head = pending.entries[0]!;
              yield* engine.dispatch({
                type: "thread.move.claim",
                threadId,
                commandId: CommandId.make("claim-before-cancel"),
                messageId: head.messageId,
                expectedRevision: head.revision,
                expectedControlRevision: pending.revision,
                createdAt: at,
              });
              const claimed = (yield* queue).entries[0]!;
              if (claimed.kind !== "move" || !claimed.operationId)
                return yield* Effect.die("Expected a claimed move");
              const owner = { ...enrolled, operationId: claimed.operationId };
              const intents = makeThreadMoveTransferIntent(sql);
              if (lost === "encoding-cancel-v2") {
                yield* intents.create(owner, [
                  "launchpad-thread-chunks-v1",
                  "launchpad-thread-chunks-v2",
                ]);
                yield* intents.bind(owner, "workspace-raw-v2-8MiB", "a".repeat(64));
              }
              yield* engine.dispatch({
                type: "thread.move.cancel",
                threadId,
                commandId: CommandId.make("cancel-before-begin"),
                messageId: claimed.messageId,
                expectedRevision: claimed.revision,
                createdAt: at,
              });
              yield* source.source(threadId);
              yield* source.source(threadId);
              expect((yield* queue).entries.map((entry) => entry.messageId)).toEqual(["prompt"]);
              expect((yield* fences.get(threadId))?.phase).toBe("active");
              expect(remote?.phase).toBe("aborted");
              expect(formatReads).toBe(0);
              expect(vmBegins).toBe(1);
              expect(selections).toBe(0);
              expect(uploadStarts).toBe(0);
              expect(yield* captures.active).toEqual([]);
              expect(yield* intents.get(owner)).toMatchObject({
                sourceThreadTransferFormats:
                  lost === "encoding-cancel-v2"
                    ? ["launchpad-thread-chunks-v1", "launchpad-thread-chunks-v2"]
                    : ["launchpad-thread-chunks-v1"],
                transferEncodingPolicy:
                  lost === "encoding-cancel-v2" ? "workspace-raw-v2-8MiB" : "v1-64MiB",
                manifestSha256: lost === "encoding-cancel-v2" ? "a".repeat(64) : null,
              });
              return;
            }
            if (lost.startsWith("capture-retargeted")) {
              const entered = yield* Deferred.make<void>();
              const release = yield* Deferred.make<void>();
              const provider = yield* ProviderService;
              source = yield* makeThreadMoveWorker(transport, history, commands).pipe(
                Effect.provideService(ProviderService, {
                  ...provider,
                  listSessions: () =>
                    Effect.gen(function* () {
                      if ((yield* captures.active).some((hold) => hold.phase === "capturing")) {
                        yield* Deferred.succeed(entered, undefined);
                        yield* Deferred.await(release);
                      }
                      return yield* provider.listSessions();
                    }),
                }),
              );
              const pending = yield* source
                .source(threadId)
                .pipe(
                  Effect.match({ onFailure: (error) => error, onSuccess: () => null }),
                  Effect.forkChild,
                );
              yield* Deferred.await(entered);
              if (lost === "capture-retargeted-alias") {
                yield* fs.remove(sourceBinding);
                yield* fs.symlink(dst, sourceBinding);
              } else if (lost === "capture-retargeted-git") {
                yield* fs.rename(path.join(src, ".git"), path.join(root, "original-git"));
                yield* fs.symlink(path.join(dst, ".git"), path.join(src, ".git"));
              } else
                yield* engine.dispatch({
                  type: "thread.meta.update",
                  commandId: CommandId.make("retarget-capturing-source"),
                  threadId,
                  worktreePath: dst,
                });
              yield* Deferred.succeed(release, undefined);
              expect(yield* Fiber.join(pending)).toMatchObject({
                _tag: "ThreadTransferArchiveError",
                message: expect.stringContaining("checkout changed"),
              });
              expect(uploadStarts).toBe(0);
              expect((yield* fences.get(threadId))?.phase).toBe("frozen");
              expect(yield* captures.active).toEqual([]);
              return;
            }
            if (lost.startsWith("capture-rename")) {
              const renamed = yield* Deferred.make<void>();
              const sync = yield* Deferred.make<void>();
              const archiveParent = path.join(
                (yield* ServerConfig).stateDir,
                "move-transfers",
                "source",
              );
              source = yield* makeThreadMoveWorker(transport, history, commands).pipe(
                Effect.provideService(FileSystem.FileSystem, {
                  ...fs,
                  open: (file, options) =>
                    Effect.gen(function* () {
                      if (file === archiveParent) {
                        yield* Deferred.succeed(renamed, undefined);
                        yield* Deferred.await(sync);
                      }
                      return yield* fs.open(file, options);
                    }),
                }),
              );
              const pending = yield* source.source(threadId).pipe(Effect.forkChild);
              yield* Deferred.await(renamed);
              yield* Fiber.interrupt(pending);
              expect((yield* captures.active)[0]?.phase).toBe("capturing");
              expect(uploadStarts).toBe(0);
              if (lost === "capture-rename-cancel") remote = { ...remote!, phase: "aborting" };
              let recoverySynced = false;
              source = yield* makeThreadMoveWorker(transport, history, commands).pipe(
                Effect.provideService(FileSystem.FileSystem, {
                  ...fs,
                  open: (file, options) =>
                    fs.open(file, options).pipe(
                      Effect.map((handle) =>
                        file === archiveParent
                          ? {
                              ...handle,
                              sync: Effect.gen(function* () {
                                expect((yield* captures.active)[0]?.phase).toBe("capturing");
                                yield* handle.sync;
                                recoverySynced = true;
                              }),
                            }
                          : handle,
                      ),
                    ),
                }),
              );
              yield* source.source(threadId);
              expect(recoverySynced).toBe(true);
              expect(yield* captures.active).toEqual([]);
              const [hold] = yield* sql<{
                phase: string;
                outcome: string;
              }>`SELECT phase,release_outcome AS outcome FROM checkout_capture_holds`;
              expect(hold).toEqual({ phase: "released", outcome: "sealed" });
              return;
            }
            if (lost === "capture-stop-failure") {
              source = yield* makeThreadMoveWorker(transport, history, commands).pipe(
                Effect.provideService(TerminalManager, {
                  ...(yield* TerminalManager),
                  close: () =>
                    Effect.fail(
                      new TerminalProcessExitError({
                        threadId,
                        terminalId: "shell",
                        terminalPid: 123,
                        detail: "Exit receipt unavailable",
                      }),
                    ),
                }),
              );
              expect((yield* Effect.flip(source.source(threadId)))._tag).toBe(
                "TerminalProcessExitError",
              );
              const [hold] = yield* sql<{
                phase: string;
                outcome: string;
              }>`SELECT phase,release_outcome AS outcome FROM checkout_capture_holds`;
              expect(hold).toEqual({ phase: "released", outcome: "failed" });
              expect((yield* fences.get(threadId))?.phase).toBe("draining");
              expect(uploadStarts).toBe(0);
              return;
            }
            if (
              [
                "shared-active",
                "shared-ready-no-git",
                "capture-cancel",
                "capture-upload-blocked",
              ].includes(lost)
            ) {
              const alias = path.join(root, "source-alias");
              yield* fs.symlink(src, alias);
              const aliasProject = ProjectId.make("alias-project");
              yield* engine.dispatch({
                type: "project.create",
                commandId: CommandId.make("alias-project"),
                projectId: aliasProject,
                title: "Alias",
                workspaceRoot: alias,
                createdAt: at,
              });
              yield* engine.dispatch({
                type: "thread.create",
                commandId: CommandId.make("sibling"),
                threadId: sibling,
                projectId: aliasProject,
                title: "Sibling",
                modelSelection: { instanceId, model: "gpt-5" },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt: at,
              });
            }
            if (lost.startsWith("shared-") || lost === "capture-cancel") {
              if (lost === "shared-ready-no-git") {
                const admitted = yield* captures.admit({
                  threadId: sibling,
                  workId: "original-turn",
                  kind: "provider",
                  checkoutRoot: src,
                });
                yield* captures.bindTurn(admitted.admissionId, "sibling-turn");
              }
              yield* sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,checkpoint_files_json,checkpoint_status)
                VALUES(${sibling},'sibling-turn','running',${at},'[]','pending')`;
              yield* source.source(threadId);
              const waiting = yield* queue;
              expect(waiting.entries[0]).toMatchObject({
                state: "moving",
                waitingForCheckout: true,
                detail: 'Waiting for "Sibling" to finish its current turn.',
              });
              const hold = (yield* captures.active)[0]!;
              expect(hold.phase).toBe("draining");
              expect(
                yield* fs.exists(
                  path.join(
                    (yield* ServerConfig).stateDir,
                    "move-transfers",
                    "source",
                    hold.operationId,
                  ),
                ),
              ).toBe(false);
              expect(
                (yield* Effect.flip(
                  execution.begin({ threadId: sibling, kind: "provider", workId: "late-turn" }),
                ))._tag,
              ).toBe("CheckoutCaptureError");
              yield* source.source(threadId);
              expect(yield* queue).toEqual(waiting);
              if (lost === "capture-cancel") {
                const head = waiting.entries[0]!;
                yield* engine.dispatch({
                  type: "thread.move.cancel",
                  commandId: CommandId.make("cancel-capture"),
                  threadId,
                  messageId: head.messageId,
                  expectedRevision: head.revision,
                  createdAt: at,
                });
                expect((yield* Effect.flip(source.source(threadId)))._tag).toBe("ThreadMoveError");
                expect(yield* captures.get(hold.operationId)).toMatchObject({
                  phase: "released",
                  releaseOutcome: "cancelled",
                });
                expect((yield* fences.get(threadId))?.phase).toBe("draining");
                expect(
                  yield* execution.begin({
                    threadId: sibling,
                    kind: "provider",
                    workId: "after-cancel",
                  }),
                ).toBe("ordinary");
                return;
              }
              const deferredSetup = yield* encodeMoveJson({
                originalCommandId: "after-hold-setup",
                attemptId: "after-hold-setup",
                revision: 0,
                state: "pending",
                settled: false,
                recipe: { projectCwd: src, runSetupScript: true },
              });
              yield* sql`UPDATE projection_thread_prompt_queues
                SET state_json=json_set(state_json,'$.preparation',json(${deferredSetup})) WHERE thread_id=${sibling}`;
              yield* sql`UPDATE projection_turns SET state='completed',completed_at=${at} WHERE thread_id=${sibling}`;
              yield* source.source(threadId);
              expect(yield* captures.get(hold.operationId)).toMatchObject({ phase: "draining" });
              expect(yield* moveDetail).toBe('Waiting for "Sibling" to finish its checkpoint.');
              yield* sql`UPDATE projection_turns SET checkpoint_status='ready' WHERE thread_id=${sibling}`;
              const background = yield* ThreadBackgroundLivenessService;
              background.recordTaskLiveness({
                threadId: sibling,
                taskId: "background",
                taskType: undefined,
                status: "running",
                kind: "started",
              });
              yield* source.source(threadId);
              expect(yield* captures.get(hold.operationId)).toMatchObject({ phase: "draining" });
              expect(yield* moveDetail).toBe(
                'Waiting for "Sibling" to finish its background work.',
              );
              background.clearThreadLiveness(sibling);
              yield* sql`UPDATE projection_turns SET state='error',checkpoint_status='error' WHERE thread_id=${sibling}`;
              if (lost === "shared-ready-no-git") {
                yield* captures.completeTurn(sibling, "sibling-turn");
                yield* sql`UPDATE projection_turns SET checkpoint_status='missing' WHERE thread_id=${sibling}`;
              }
              yield* (yield* ProviderSessionRuntimeRepository).upsert({
                threadId: sibling,
                providerName: "codex",
                providerInstanceId: instanceId,
                adapterKey: "codex",
                runtimeMode: "full-access",
                status: "running",
                lastSeenAt: at,
                resumeCursor: { threadId: "sibling-native" },
                runtimePayload: { activeTurnId: "sibling-turn" },
              });
              const separate = path.join(root, "other-worktree");
              yield* git(src, ["worktree", "add", "--detach", separate]);
              const separateId = ThreadId.make("separate");
              yield* engine.dispatch({
                type: "thread.create",
                commandId: CommandId.make("separate"),
                threadId: separateId,
                projectId,
                title: "Separate",
                modelSelection: { instanceId, model: "gpt-5" },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: separate,
                createdAt: at,
              });
              yield* sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,checkpoint_files_json,checkpoint_status)
                VALUES(${separateId},'separate-turn','running',${at},'[]','pending')`;
              yield* execution.begin({
                threadId: separateId,
                kind: "provider",
                workId: "active-separate",
              });
              const provider = yield* ProviderService;
              let siblingStatus: ProviderSession["status"] = "running";
              source = yield* makeThreadMoveWorker(transport, history, commands).pipe(
                Effect.provideService(ProviderService, {
                  ...provider,
                  listSessions: () =>
                    Effect.succeed([
                      {
                        threadId: sibling,
                        provider: driverKind,
                        providerInstanceId: instanceId,
                        runtimeMode: "full-access",
                        status: siblingStatus,
                        activeTurnId: TurnId.make("sibling-turn"),
                        createdAt: at,
                        updatedAt: at,
                      },
                      {
                        threadId: separateId,
                        provider: driverKind,
                        providerInstanceId: instanceId,
                        runtimeMode: "full-access",
                        status: "running",
                        activeTurnId: TurnId.make("separate-turn"),
                        createdAt: at,
                        updatedAt: at,
                      },
                    ]),
                }),
              );
              yield* source.source(threadId);
              expect(yield* captures.get(hold.operationId)).toMatchObject({ phase: "draining" });
              expect(yield* moveDetail).toBe('Waiting for "Sibling" to finish its provider turn.');
              siblingStatus = "ready";
            }
            if (lost === "capture-failure") {
              source = yield* makeThreadMoveWorker(transport, history, commands).pipe(
                Effect.provideService(FileSystem.FileSystem, {
                  ...fs,
                  readDirectory: (directory) =>
                    fs.readDirectory(
                      directory === src ? path.join(root, "missing-capture-input") : directory,
                    ),
                }),
              );
              yield* Effect.flip(source.source(threadId));
              expect((yield* fences.get(threadId))?.phase).toBe("frozen");
              const [hold] = yield* sql<{
                phase: string;
                outcome: string;
              }>`SELECT phase,release_outcome AS outcome FROM checkout_capture_holds`;
              expect(hold).toEqual({ phase: "released", outcome: "failed" });
              return;
            }
            if (lost === "capture-upload-blocked") {
              const pending = yield* source.source(threadId).pipe(Effect.forkChild);
              yield* Deferred.await(uploadEntered);
              const [hold] = yield* sql<{
                phase: string;
                outcome: string;
              }>`SELECT phase,release_outcome AS outcome FROM checkout_capture_holds`;
              expect(hold).toEqual({ phase: "released", outcome: "sealed" });
              expect((yield* fences.get(threadId))?.phase).toBe("frozen");
              expect(
                yield* execution.begin({
                  threadId: sibling,
                  kind: "provider",
                  workId: "during-upload",
                }),
              ).toBe("ordinary");
              yield* fs.writeFileString(path.join(src, "after-capture"), "new sibling work\n");
              yield* Deferred.succeed(uploadRelease, undefined);
              yield* Fiber.join(pending);
              source = yield* makeThreadMoveWorker(transport, history, commands);
            }
            if (lost === "sealed-missing") {
              expect((yield* Effect.flip(source.source(threadId)))._tag).toBe("ThreadMoveError");
              const [hold] = yield* sql<{
                operationId: string;
                digest: string;
              }>`SELECT operation_id AS "operationId",manifest_sha256 AS digest FROM checkout_capture_holds WHERE release_outcome='sealed'`;
              const completedUploads = uploadStarts;
              yield* fs.remove(
                path.join(
                  (yield* ServerConfig).stateDir,
                  "move-transfers",
                  "source",
                  hold!.operationId,
                ),
                { recursive: true },
              );
              source = yield* makeThreadMoveWorker(transport, history, commands);
              const error = yield* Effect.flip(source.source(threadId));
              expect(error).toMatchObject({
                _tag: "ThreadMoveError",
                detail: expect.stringContaining("sealed source archive is missing"),
              });
              expect(uploadStarts).toBe(completedUploads);
              expect(yield* captures.get(hold!.operationId)).toMatchObject({
                phase: "released",
                releaseOutcome: "sealed",
                manifestSha256: hold!.digest,
              });
              expect((yield* fences.get(threadId))?.phase).toBe("frozen");
              return;
            }
            if (lost === "source-retargeted-project") {
              const error = yield* Effect.flip(source.source(threadId));
              if (error._tag !== "ThreadMoveError") throw error;
              expect(error.detail).toContain("different destination");
              expect((yield* fences.get(threadId))?.phase).toBe("active");
              const head = (yield* queue).entries[0];
              expect(head?.kind === "move" && head.destination).toEqual({
                kind: "environment",
                environmentId: destinationId,
                projectId,
              });
              expect(yield* fs.readFileString(path.join(src, "README"))).toBe("uncommitted work\n");
              expect(commits).toBe(0);
              return;
            }
            if (lost === "source-export") {
              yield* fs.rename(src, `${src}-saved`);
              const error = yield* Effect.flip(source.source(threadId));
              expect(remote?.phase).toBe("preparing");
              expect(remote?.failureDetail).toBeTruthy();
              expect((yield* queue).entries[0]?.state).toBe("moving");
              expect((yield* fences.get(threadId))?.phase).toBe("draining");
              expect(yield* captures.active).toEqual([]);
              expect(error._tag).not.toBe("ThreadMoveError");
              expect(commits).toBe(0);
              return;
            }
            if (
              lost === "recovery-publish" ||
              lost === "recovery-ready" ||
              lost === "recovery-sticky-failure" ||
              lost === "recovery-two-failures"
            ) {
              expect((yield* Effect.flip(source.source(threadId)))._tag).toBe("ThreadMoveError");
              expect(remote?.manifestArtifactId).not.toBeNull();
              const completedUploads = uploadStarts;
              if (lost === "recovery-ready") remote = { ...remote!, phase: "ready" };
              if (lost === "recovery-sticky-failure")
                remote = { ...remote!, failureDetail: "Frozen recovery save is not confirmed." };
              if (lost === "recovery-two-failures")
                remote = {
                  ...remote!,
                  phase: "ready",
                  failureDetail: "Destination preparation is blocked.",
                  participantStates: [
                    ...remote!.participantStates!,
                    {
                      environmentId: destinationId,
                      generation: 2,
                      resolvedBeforeAttempt: 0,
                      failure: {
                        attempt: 1,
                        detail: "Destination preparation is blocked.",
                        reportedAt: at,
                      },
                    },
                  ],
                };
              source = yield* makeThreadMoveWorker(transport, history, commands);
              yield* source.source(threadId);
              expect(uploadStarts).toBe(completedUploads);
              expect(remote?.recoveryVerified).toBe(true);
              if (lost === "recovery-two-failures") {
                expect(remote?.failureDetail).toBe("Destination preparation is blocked.");
                expect(commits).toBe(0);
                yield* source.source(threadId);
                expect(remote?.phase).toBe("ready");
                expect(remote?.failureDetail).toBe("Destination preparation is blocked.");
                expect(commits).toBe(0);
                expect(uploadStarts).toBe(completedUploads);
                return;
              }
            }
            if (lost === "encoding-missing") {
              expect(yield* Effect.flip(source.source(threadId))).toMatchObject({
                detail: expect.stringContaining("did not confirm"),
              });
              expect(uploadStarts).toBe(0);
              expect(yield* captures.active).toEqual([]);
              const [intent] =
                yield* sql`SELECT encoding_policy,manifest_sha256 FROM thread_move_transfer_intents`;
              expect(intent).toEqual({ encoding_policy: null, manifest_sha256: null });
              return;
            }
            if (lost === "encoding-health-retry") {
              expect((yield* Effect.flip(source.source(threadId)))._tag).toBe("ThreadMoveError");
              expect(remote).toBeUndefined();
              expect(uploadStarts).toBe(0);
              expect(yield* sql`SELECT * FROM thread_move_transfer_intents`).toEqual([]);
              expect(yield* captures.active).toEqual([]);
              source = yield* makeThreadMoveWorker(transport, history, commands);
            }
            if (lost === "encoding-wait") {
              yield* source.source(threadId);
              expect(remote?.transferEncodingPolicy).toBeNull();
              expect(uploadStarts).toBe(0);
              expect(yield* captures.active).toEqual([]);
              source = yield* makeThreadMoveWorker(transport, history, commands);
            }
            if (["upload", "packed-v2", "encoding-change"].includes(lost)) {
              expect((yield* Effect.flip(source.source(threadId)))._tag).toBe("ThreadMoveError");
              expect(activeUploads).toBe(0);
              expect(remote?.manifestArtifactId).toBeNull();
              expect((yield* fences.get(threadId))?.phase).toBe("frozen");
              expect((yield* queue).entries.map((entry) => entry.messageId)).toEqual([
                "move",
                "prompt",
              ]);
              source = yield* makeThreadMoveWorker(transport, history, commands);
              if (lost === "encoding-change") {
                const before = uploadStarts;
                remote = { ...remote!, transferEncodingPolicy: "v1-64MiB" };
                expect(yield* Effect.flip(source.source(threadId))).toMatchObject({
                  detail: expect.stringContaining("encoding changed"),
                });
                expect(uploadStarts).toBe(before);
                expect(remote?.failureDetail).toContain("encoding changed");
                return;
              }
            }
            yield* source.source(threadId);
            expect(remote?.phase).toBe(lost === "recovery-ready" ? "committed" : "frozen");
            if (lost === "recovery-ready") {
              expect(remote?.recoveryVerified).toBe(true);
              expect((yield* fences.get(threadId))?.phase).toBe("retired");
              expect(commits).toBe(1);
              return;
            }
            const [capture] = yield* sql<{
              phase: string;
              outcome: string;
            }>`SELECT phase,release_outcome AS outcome FROM checkout_capture_holds`;
            expect(capture).toEqual({ phase: "released", outcome: "sealed" });
            if (lost.startsWith("shared-"))
              expect((yield* queue).entries[0]).not.toHaveProperty("waitingForCheckout");
            expect(remote?.manifestArtifactId).not.toBeNull();
            const index = yield* decodeTransferIndex(
              new TextDecoder().decode(uploads.get(remote!.manifestArtifactId!)!),
            );
            expect(index.format).toBe(
              packedEncoding ? "launchpad-thread-chunks-v2" : "launchpad-thread-chunks-v1",
            );
            expect(formatReads).toBe(lost === "encoding-health-retry" ? 2 : 1);
            if (lost === "encoding-health-retry") expect(selections).toBe(1);
            if (lost === "parallel-transfer") expect(maximumUploads).toBe(4);
            if (lost === "published") {
              const completedUploads = uploadStarts;
              const publishedId = remote!.manifestArtifactId;
              // A restarted source waits for destination readiness without sending saved bytes again.
              source = yield* makeThreadMoveWorker(transport, history, commands);
              yield* source.source(threadId);
              expect(uploadStarts).toBe(completedUploads);
              expect(remote!.manifestArtifactId).toBe(publishedId);
              expect((yield* fences.get(threadId))?.phase).toBe("frozen");
            }
            yield* Effect.flip(
              fences.beginWork({ threadId, generation: 1, workId: "premature", kind: "provider" }),
            );
            yield* Effect.gen(function* () {
              const destinationEngine = yield* OrchestrationEngineService,
                destinationSql = yield* SqlClient.SqlClient,
                destinationFences = makeThreadExecutionFence(destinationSql);
              const destinationRoot =
                lost === "destination-nested-project" ? path.join(dst, "nested") : dst;
              if (lost === "destination-nested-project") yield* fs.makeDirectory(destinationRoot);
              yield* destinationEngine.dispatch({
                type: "project.create",
                commandId: CommandId.make("destination-project"),
                projectId: targetProjectId,
                title: "Destination",
                workspaceRoot: destinationRoot,
                createdAt: at,
              });
              const oldHead = (yield* git(dst, ["rev-parse", "HEAD"])).stdout.trim();
              let repointed: string | undefined;
              if (lost === "destination-repointed-project") {
                repointed = path.join(root, "repointed");
                yield* git(root, ["clone", "--no-local", dst, repointed]);
                yield* git(repointed, [
                  "remote",
                  "set-url",
                  "origin",
                  "https://github.com/test/other.git",
                ]);
                yield* fs.writeFileString(path.join(repointed, "README"), "repointed local work\n");
                yield* destinationSql`UPDATE projection_projects SET workspace_root=${repointed} WHERE project_id=${projectId}`;
              }
              if (lost === "destination-wrong-repository") {
                const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
                expect((yield* identities.resolve(dst))?.canonicalKey).toBe(
                  "github.com/test/enrollment",
                );
                yield* git(dst, [
                  "remote",
                  "set-url",
                  "origin",
                  "https://github.com/test/other.git",
                ]);
              }
              if (validationFailure)
                yield* fs.writeFileString(path.join(dst, "README"), "destination local work\n");
              const destinationHistory = makeThreadHistorySync(destinationSql, destinationEngine, {
                append: () => Effect.void,
                confirmThrough: () => Effect.void,
              });
              let destinationAuthenticated = false;
              let recoveryMustSkipAuth = false;
              const destinationInstance: ProviderInstance = {
                ...instance,
                snapshot: {
                  ...instance.snapshot,
                  refresh: Effect.suspend(() =>
                    recoveryMustSkipAuth
                      ? Effect.die("A durable ready receipt must recover without provider auth")
                      : Effect.succeed({
                          ...status,
                          auth: {
                            status:
                              (lost !== "destination-auth" && !postInstallAuthLoss) ||
                              destinationAuthenticated
                                ? "authenticated"
                                : "unauthenticated",
                          },
                        }),
                  ),
                },
              };
              let destination = yield* makeThreadMoveWorker(
                transport,
                destinationHistory,
                commands,
              ).pipe(
                Effect.provide(
                  ["destination-auth", "ready", "commit"].includes(lost) || postInstallAuthLoss
                    ? Layer.mock(ProviderInstanceRegistry)({
                        getInstance: () => Effect.succeed(destinationInstance),
                      })
                    : Layer.empty,
                ),
              );
              const owner = {
                threadId,
                environmentId: destinationId,
                relayUrl: enrolled.relayUrl,
                generation: 2,
                operationId: remote!.operationId,
              };
              if (lost === "destination-ready-receipt") {
                yield* destinationSql`CREATE TEMP TRIGGER fail_destination_ready BEFORE UPDATE OF phase ON thread_transfer_readiness
                  WHEN NEW.phase='ready' BEGIN SELECT RAISE(ABORT,'lost readiness receipt'); END`;
                yield* Effect.flip(destination.destination(owner));
                expect(remote?.failureDetail).toBeTruthy();
                expect(
                  yield* destinationSql`SELECT setup_succeeded,provider_probe_attempt_id FROM thread_transfer_readiness WHERE operation_id=${owner.operationId}`,
                ).toEqual([{ setup_succeeded: 1, provider_probe_attempt_id: null }]);
                yield* destinationSql`DROP TRIGGER fail_destination_ready`;
              }
              if (lost === "destination-baseline-receipt") {
                yield* destinationSql`CREATE TEMP TRIGGER fail_baseline BEFORE INSERT ON thread_transfer_baselines
                  BEGIN SELECT RAISE(ABORT,'lost baseline receipt'); END`;
                yield* Effect.flip(destination.destination(owner));
                expect(
                  yield* destinationSql`SELECT phase FROM thread_checkout_claims
                  WHERE operation_id=${owner.operationId}`,
                ).toEqual([{ phase: "installed" }]);
                expect(yield* destinationSql`SELECT 1 FROM thread_transfer_baselines`).toEqual([]);
                yield* destinationSql`DROP TRIGGER fail_baseline`;
              }
              if (validationFailure) {
                const worktreesRoot = (yield* ServerConfig).worktreesDir;
                const localWorktrees = yield* fs.readDirectory(worktreesRoot);
                const error = yield* Effect.flip(destination.destination(owner));
                if (error._tag !== "ThreadMoveError") throw error;
                expect(error.detail).toContain(
                  lost === "destination-nested-project" ? "Git checkout root" : "repository",
                );
                expect(remote?.failureDetail).toBe(error.detail);
                expect((yield* destinationFences.get(threadId))?.phase ?? null).toBe(
                  lost === "destination-repointed-during-download" ? "frozen" : null,
                );
                expect(yield* destinationSql`SELECT 1 FROM thread_checkout_claims`).toEqual([]);
                expect(yield* fs.readDirectory(worktreesRoot)).toEqual(localWorktrees);
                expect((yield* git(dst, ["rev-parse", "HEAD"])).stdout.trim()).toBe(oldHead);
                expect(yield* fs.readFileString(path.join(dst, "README"))).toBe(
                  "destination local work\n",
                );
                if (repointed)
                  expect(yield* fs.readFileString(path.join(repointed, "README"))).toBe(
                    "repointed local work\n",
                  );
                expect(commits).toBe(0);
                remote = { ...remote!, phase: "aborting" };
                yield* destination.destination(owner);
                expect(remote?.phase).toBe("aborted");
                expect((yield* destinationFences.get(threadId))?.phase ?? null).toBe(
                  lost === "destination-repointed-during-download" ? "retired" : null,
                );
                return;
              }
              if (lost.startsWith("cancel-")) {
                const error = yield* Effect.flip(destination.destination(owner));
                expect(error._tag).toBe("ThreadTransferReadinessError");
                expect(error.message).toContain("Destination project setup failed");
                if (lost !== "cancel-report") {
                  expect(remote?.failureDetail).toBe(error.message);
                  const beforeFailure = yield* sourceQueue;
                  yield* source.source(threadId);
                  expect(yield* sourceQueue).toEqual(beforeFailure);
                  expect((yield* fences.get(threadId))?.phase).toBe("frozen");
                  expect(commits).toBe(0);
                  const waiting = yield* makeThreadMoveWorker(
                    transport,
                    destinationHistory,
                    commands,
                  ).pipe(
                    Effect.provideService(FileSystem.FileSystem, {
                      ...fs,
                      exists: () => Effect.die("A failed move must not read its archive again"),
                    }),
                  );
                  yield* waiting.destination(owner);
                  expect(remote?.failureDetail).toBe(error.message);
                  yield* source.source(threadId);
                  expect(yield* sourceQueue).toEqual(beforeFailure);
                } else expect(remote?.failureDetail).toBeNull();
                expect((yield* destinationFences.get(threadId))?.phase).toBe("frozen");
                expect(yield* fs.readFileString(path.join(dst, "README"))).toBe("setup edit\n");
                remote = { ...remote!, phase: "aborting" };
                if (lost === "cancel-edit") {
                  yield* fs.writeFileString(path.join(dst, "README"), "outside edit\n");
                  yield* Effect.flip(destination.destination(owner));
                  expect(remote?.phase).toBe("aborting");
                  expect((yield* destinationFences.get(threadId))?.phase).toBe("frozen");
                  expect(yield* fs.readFileString(path.join(dst, "README"))).toBe("outside edit\n");
                  yield* fs.writeFileString(path.join(dst, "README"), "setup edit\n");
                }
                if (lost === "cancel-uncertain") {
                  const [receipt] = yield* destinationSql<{
                    output: string;
                  }>`SELECT setup_output_json AS output FROM thread_transfer_readiness WHERE operation_id=${owner.operationId}`;
                  yield* destinationSql`UPDATE thread_transfer_readiness SET setup_output_json=NULL WHERE operation_id=${owner.operationId}`;
                  yield* Effect.flip(destination.destination(owner));
                  expect(remote?.phase).toBe("aborting");
                  expect((yield* destinationFences.get(threadId))?.phase).toBe("frozen");
                  yield* destinationSql`UPDATE thread_transfer_readiness SET setup_output_json=${receipt!.output} WHERE operation_id=${owner.operationId}`;
                  yield* destinationSql`UPDATE thread_transfer_readiness SET provider_probe_attempt_id='uncertain-probe' WHERE operation_id=${owner.operationId}`;
                  yield* Effect.flip(destination.destination(owner));
                  expect(remote?.phase).toBe("aborting");
                  expect(yield* fs.readFileString(path.join(dst, "README"))).toBe("setup edit\n");
                  yield* destinationSql`UPDATE thread_transfer_readiness SET provider_probe_attempt_id=NULL WHERE operation_id=${owner.operationId}`;
                }
                yield* destination.destination(owner);
                expect(remote?.phase).toBe("aborted");
                expect((yield* destinationFences.get(threadId))?.phase).toBe("retired");
                expect(yield* fs.readFileString(path.join(dst, "README"))).toBe("committed\n");
                expect(yield* fs.exists(path.join(dst, "setup-count"))).toBe(false);
                const recovery = path.join(
                  path.dirname(dst),
                  `.launchpad-move-recovery-${NodeCrypto.createHash("sha256").update(owner.operationId).digest("hex")}`,
                );
                expect(yield* fs.readFileString(path.join(recovery, "node_modules", "proof"))).toBe(
                  "deps",
                );
                yield* destination.destination(owner);
                return;
              }
              if (lost === "ready" || lost === "commit" || lost === "activate") {
                yield* Effect.flip(destination.destination(owner));
                expect((yield* destinationFences.get(threadId))?.phase).toBe("frozen");
                if (lost === "ready" || lost === "commit") recoveryMustSkipAuth = true;
                if (lost === "commit") {
                  expect(remote?.phase).toBe("committed");
                  expect(
                    yield* destinationSql`SELECT phase FROM thread_checkout_claims
                    WHERE operation_id=${owner.operationId}`,
                  ).toEqual([{ phase: "installed" }]);
                  expect(
                    yield* destinationSql`SELECT phase FROM thread_transfer_readiness
                    WHERE operation_id=${owner.operationId}`,
                  ).toEqual([{ phase: "ready" }]);
                  remote = { ...remote!, repositoryCanonicalKeys: [] };
                  yield* git(dst, [
                    "remote",
                    "set-url",
                    "origin",
                    "https://github.com/test/changed.git",
                  ]);
                }
                yield* Effect.flip(
                  destinationFences.beginWork({
                    threadId,
                    generation: 2,
                    workId: "premature",
                    kind: "provider",
                  }),
                );
                destination = yield* makeThreadMoveWorker(
                  transport,
                  destinationHistory,
                  commands,
                ).pipe(
                  Effect.provide(
                    lost === "ready" || lost === "commit"
                      ? Layer.mock(ProviderInstanceRegistry)({
                          getInstance: () => Effect.succeed(destinationInstance),
                        })
                      : Layer.empty,
                  ),
                );
              }
              if (lost === "destination-auth" || postInstallAuthLoss) {
                const error = yield* Effect.flip(destination.destination(owner));
                expect(error.message).toContain("configured sign-in");
                expect(remote?.failureDetail).toBe(error.message);
                expect(
                  yield* destinationSql`SELECT phase FROM thread_transfer_readiness
                    WHERE operation_id=${owner.operationId}`,
                ).toEqual([]);
                expect((yield* destinationFences.get(threadId))?.phase).toBe("frozen");
                expect(commits).toBe(0);
                destinationAuthenticated = true;
                const transfers = path.join((yield* ServerConfig).stateDir, "move-transfers");
                destination = yield* makeThreadMoveWorker(
                  transport,
                  destinationHistory,
                  commands,
                ).pipe(
                  Effect.provideService(FileSystem.FileSystem, {
                    ...fs,
                    readFileString: (file, encoding) =>
                      file.startsWith(`${transfers}${path.sep}`)
                        ? Effect.die("Authentication recovery must reuse the installed baseline")
                        : fs.readFileString(file, encoding),
                  }),
                  Effect.provideService(ProviderInstanceRegistry, {
                    getInstance: () => Effect.succeed(destinationInstance),
                    listInstances: Effect.succeed([destinationInstance]),
                    listUnavailable: Effect.succeed([]),
                    streamChanges: Stream.empty,
                    subscribeChanges: Effect.die("No provider subscription during transfer"),
                  }),
                );
                if (postInstallAuthLoss) {
                  const vm = {
                    operationId: owner.operationId,
                    environmentId: destinationId,
                    relayUrl: owner.relayUrl,
                    relayIssuer: owner.relayUrl,
                    environmentCredential: "fixture-private-credential",
                    cloudMintPublicKey: "fixture-key",
                    scope: {
                      allocationId: "allocation",
                      threadId,
                      repositoryId: "repository",
                      generation: 2,
                    },
                  };
                  let authReads = 0;
                  let authLost = true;
                  const tracked = Layer.mergeAll(
                    Layer.succeed(VmWorkloadTracking, true),
                    Layer.succeed(ServerEnvironmentIdentity, {
                      getEnvironmentId: Effect.succeed(destinationId),
                    }),
                    Layer.mock(ServerSecretStore)({
                      get: (key) =>
                        Effect.succeed(
                          key === THREAD_VM_IDENTITY_SECRET
                            ? Option.some(new TextEncoder().encode(JSON.stringify(vm)))
                            : Option.none(),
                        ),
                    }),
                    Layer.mock(ThreadVmProviderAuth)({
                      readiness: () =>
                        Effect.sync(() => {
                          authReads++;
                          return authLost && authReads === 2
                            ? {
                                _tag: "Waiting" as const,
                                reason:
                                  lost === "vm-auth-personal"
                                    ? ("personal_sign_in" as const)
                                    : ("organization_connection" as const),
                              }
                            : { _tag: "Ready" as const };
                        }),
                    }),
                  );
                  const installedClaim =
                    yield* destinationSql`SELECT * FROM thread_checkout_claims WHERE operation_id=${owner.operationId}`;
                  const importedBaseline =
                    yield* destinationSql`SELECT * FROM thread_transfer_baselines WHERE operation_id=${owner.operationId}`;
                  expect(installedClaim).toHaveLength(1);
                  expect(importedBaseline).toHaveLength(1);
                  const resumed = () =>
                    makeThreadMoveWorker(transport, destinationHistory, commands).pipe(
                      Effect.provide(tracked),
                      Effect.provideService(FileSystem.FileSystem, {
                        ...fs,
                        readFileString: (file, encoding) =>
                          file.startsWith(`${transfers}${path.sep}`)
                            ? Effect.die(
                                "VM auth recovery must not reconstruct or reinstall the archive",
                              )
                            : fs.readFileString(file, encoding),
                      }),
                    );
                  destination = yield* resumed();
                  const completedDownloads = downloadStarts;
                  yield* destination.destination(owner);
                  expect(authReads).toBe(2);
                  expect(remote?.phase).toBe("frozen");
                  expect(remote?.failureDetail).toBeNull();
                  expect(destinationProgress.at(-1)?.waitingForAuth).toBe(
                    lost === "vm-auth-personal" ? "personal_sign_in" : "organization_connection",
                  );
                  expect(
                    yield* destinationSql`SELECT * FROM thread_checkout_claims WHERE operation_id=${owner.operationId}`,
                  ).toEqual(installedClaim);
                  expect(
                    yield* destinationSql`SELECT * FROM thread_transfer_baselines WHERE operation_id=${owner.operationId}`,
                  ).toEqual(importedBaseline);
                  expect(
                    yield* destinationSql`SELECT 1 FROM thread_transfer_readiness WHERE operation_id=${owner.operationId}`,
                  ).toEqual([]);
                  expect(downloadStarts).toBe(completedDownloads);
                  expect(commits).toBe(0);
                  expect((yield* fences.get(threadId))?.phase).toBe("frozen");
                  yield* Effect.flip(
                    destinationFences.beginWork({
                      threadId,
                      generation: 2,
                      workId: "premature-auth-wait",
                      kind: "provider",
                    }),
                  );
                  authLost = false;
                  destination = yield* resumed();
                  yield* destination.destination(owner);
                  expect(authReads).toBe(4);
                  expect(remote?.phase).toBe("completed");
                  expect(downloadStarts).toBe(completedDownloads);
                  expect(
                    yield* destinationSql`SELECT * FROM thread_checkout_claims WHERE operation_id=${owner.operationId}`,
                  ).toEqual(
                    installedClaim.map((claim) => ({
                      ...claim,
                      phase: "released",
                      release_reason: "activated",
                    })),
                  );
                  expect(
                    yield* destinationSql`SELECT * FROM thread_transfer_baselines WHERE operation_id=${owner.operationId}`,
                  ).toEqual(importedBaseline);
                  expect(
                    yield* destinationSql`SELECT phase,setup_succeeded FROM thread_transfer_readiness WHERE operation_id=${owner.operationId}`,
                  ).toEqual([{ phase: "ready", setup_succeeded: 1 }]);
                }
              }
              if (lost === "destination-awaits-recovery") {
                remote = {
                  ...remote!,
                  recoveryVerified: false,
                  failureDetail: "Frozen recovery save is not confirmed.",
                };
                for (let attempt = 0; attempt < 2; attempt++) {
                  yield* destination.destination(owner);
                  expect(remote?.phase).toBe("ready");
                  expect(remote?.failureDetail).toBeNull();
                  expect(commitAttempts).toBe(0);
                  expect((yield* destinationFences.get(threadId))?.phase).toBe("frozen");
                  expect((yield* fences.get(threadId))?.phase).toBe("frozen");
                }
                yield* source.source(threadId);
                expect(remote?.recoveryVerified).toBe(true);
              }
              yield* destination.destination(owner);
              expect(remote?.phase).toBe("completed");
              expect((yield* destinationFences.get(threadId))?.phase).toBe("active");
              if (packedEncoding) {
                const completed = destinationProgress.findLast(
                  (report) => report.stage === "downloading",
                )!;
                expect(completed.totalArtifacts).toBe(uploads.size);
                expect(completed.completedArtifacts).toBe(uploads.size);
                expect(completed.completedBytes).toBe(
                  Array.from(uploads.values()).reduce((sum, bytes) => sum + bytes.length, 0),
                );
                expect(new Set(downloadedArtifacts).size).toBe(uploads.size);
                expect(downloadedArtifacts.length).toBe(uploads.size);
              }
              expect((yield* queue).entries.map((entry) => entry.messageId)).toEqual(["prompt"]);
              expect(yield* fs.readFileString(path.join(dst, "README"))).toBe("uncommitted work\n");
              if (lost === "capture-upload-blocked")
                expect(yield* fs.exists(path.join(dst, "after-capture"))).toBe(false);
              if (lost === "parallel-transfer") {
                expect(maximumDownloads).toBe(4);
                expect(activeDownloads).toBe(0);
                for (let i = 0; i < 8; i++)
                  expect(yield* fs.readFileString(path.join(dst, `dirty-${i}`))).toBe(
                    `unsaved work ${i}\n`,
                  );
              }
              yield* destination.destination(owner);
              expect((yield* queue).entries.map((entry) => entry.messageId)).toEqual(["prompt"]);
            }).pipe(Effect.provide(environment(path.join(root, "destination-state"))));
            yield* source.source(threadId);
            if (validationFailure) {
              expect((yield* fences.get(threadId))?.phase).toBe("active");
              expect((yield* queue).entries.map((entry) => entry.messageId)).toEqual(["prompt"]);
              expect(yield* fs.readFileString(path.join(src, "README"))).toBe("uncommitted work\n");
              expect(commits).toBe(0);
              return;
            }
            if (lost.startsWith("cancel-")) {
              expect((yield* fences.get(threadId))?.phase).toBe("active");
              expect((yield* queue).entries.map((entry) => entry.messageId)).toEqual(["prompt"]);
              expect(commits).toBe(0);
              return;
            }
            expect((yield* fences.get(threadId))?.phase).toBe("retired");
            expect(yield* fs.readFileString(path.join(src, "README"))).toBe("uncommitted work\n");
            expect(commits).toBe(1);
          }).pipe(Effect.provide(environment(path.join(root, "source-state"))));
        }),
      ).pipe(Effect.provide(RunnerLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );

for (const replacementPhase of ["awaiting_choice", "waiting", "cancelled"] as const)
  it.effect(
    `retains idle provider execution and the queue during a ${replacementPhase} VM replacement`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem,
            path = yield* Path.Path;
          const root = yield* fs.realPath(
            yield* fs.makeTempDirectoryScoped({ prefix: "move-quota-" }),
          );
          yield* Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService,
              sql = yield* SqlClient.SqlClient;
            const fences = makeThreadExecutionFence(sql);
            yield* engine.dispatch({
              type: "project.create",
              commandId: CommandId.make("project"),
              projectId,
              title: "Source",
              workspaceRoot: root,
              createdAt: at,
            });
            yield* engine.dispatch({
              type: "thread.create",
              commandId: CommandId.make("thread"),
              threadId,
              projectId,
              title: "Move",
              modelSelection: { instanceId, model: "gpt-5" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "main",
              worktreePath: null,
              createdAt: at,
            });
            yield* engine.dispatch({
              type: "thread.move.enqueue",
              commandId: CommandId.make("queue-move"),
              threadId,
              messageId: MessageId.make("move"),
              destination: { kind: "vm" },
              author: { userId: "owner", displayName: "Owner", imageUrl: null },
              createdAt: at,
            });
            yield* engine.dispatch({
              type: "thread.prompt.enqueue",
              commandId: CommandId.make("queue-prompt"),
              threadId,
              message: {
                messageId: MessageId.make("prompt"),
                text: "Run after moving",
                attachments: [],
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: at,
            });
            const enrolled = {
              threadId,
              projectId,
              environmentId: sourceId,
              relayUrl: "https://relay.test",
              generation: 1,
              operationId: "enroll",
            };
            yield* fences.prepare(enrolled);
            yield* fences.activate(enrolled);
            if (replacementPhase === "awaiting_choice")
              for (const workId of ["provider:start-session:idle", "provider:send-turn:settled"])
                yield* fences.beginWork({ ...enrolled, workId, kind: "provider" });
            const transport: ThreadMoveTransport = {
              sourceFormats: () => Effect.succeed(["launchpad-thread-chunks-v1"] as const),
              selectEncoding: unused,
              pending: unused,
              begin: unused,
              get: unused,
              progress: unused,
              failed: unused,
              freeze: unused,
              upload: unused,
              ready: unused,
              commit: unused,
              activate: unused,
              abort: unused,
              removed: unused,
              publish: unused,
              artifact: unused,
              beginVm: (owner) =>
                Effect.succeed({
                  status: "quota_reached",
                  maxVms: 1,
                  reservedVms: 1,
                  suggestedReplacement: null,
                  replacement: {
                    requestId: owner.operationId,
                    threadId,
                    phase: replacementPhase,
                    victimAllocationId: replacementPhase === "waiting" ? "old-vm" : null,
                    errorCode: null,
                  },
                }),
            };
            const history = makeThreadHistorySync(sql, engine, {
              append: () => Effect.void,
              confirmThrough: () => Effect.void,
            });
            const worker = yield* makeThreadMoveWorker(transport, history, {
              synchronize: () => Effect.void,
            });
            if (replacementPhase === "awaiting_choice") {
              const workspace = {
                ...enrolled,
                workId: "workspace:write",
                kind: "workspace" as const,
              };
              yield* fences.beginWork(workspace);
              yield* worker.source(threadId);
              expect((yield* queue).entries[0]?.state).toBe("pending");
              yield* fences.completeWork(workspace);
              yield* fences.acknowledgeWork(workspace);
              yield* sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,checkpoint_files_json,checkpoint_status)
                VALUES(${threadId},'active-turn','running',${at},'[]','pending')`;
              yield* worker.source(threadId);
              expect((yield* queue).entries[0]?.state).toBe("pending");
              yield* sql`UPDATE projection_turns SET state='completed',completed_at=${at}
                WHERE thread_id=${threadId} AND turn_id='active-turn'`;
              yield* worker.source(threadId);
              expect((yield* queue).entries[0]?.state).toBe("pending");
              yield* sql`UPDATE projection_turns SET checkpoint_status='ready'
                WHERE thread_id=${threadId} AND turn_id='active-turn'`;
            }
            const result = yield* Effect.result(worker.source(threadId));
            expect((yield* fences.get(threadId))?.phase).toBe("active");
            expect((yield* fences.get(threadId))?.operationId).toBe("enroll");
            const q = yield* queue;
            expect(q.entries.map((entry) => entry.messageId)).toEqual(["move", "prompt"]);
            expect(result._tag).toBe("Success");
            expect(q.entries[0]).toMatchObject({
              state: "blocked",
              detail:
                replacementPhase === "cancelled"
                  ? "VM replacement was cancelled. Cancel this move to continue here."
                  : replacementPhase === "waiting"
                    ? "Saving the selected VM. This move will continue after its slot is safely released."
                    : "VM limit reached (1/1). Select an idle VM to replace before this move can continue.",
            });
            expect(
              yield* sql`SELECT 1 FROM thread_execution_work WHERE thread_id=${threadId} AND completed=0`,
            ).toHaveLength(replacementPhase === "awaiting_choice" ? 2 : 0);
          }).pipe(Effect.provide(environment(path.join(root, "source-state"))));
        }),
      ).pipe(Effect.provide(RunnerLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );

it.effect("enrolls a settled native turn despite its last-admitted runtime marker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "move-settled-" }),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const engine = yield* OrchestrationEngineService;
        const runtime = yield* ProviderSessionRuntimeRepository;
        const provider = yield* ProviderService;
        const runner = yield* ProcessRunner;
        for (const args of [
          ["init", "-b", "main"],
          ["remote", "add", "origin", "https://github.com/test/enrollment.git"],
        ]) {
          const result = yield* runner.run({ command: "git", args, cwd: root });
          expect(result.code).toBe(0);
        }
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("project"),
          projectId,
          title: "Source",
          workspaceRoot: root,
          createdAt: at,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("thread"),
          threadId,
          projectId,
          title: "Move",
          modelSelection: { instanceId, model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          createdAt: at,
        });
        yield* engine.dispatch({
          type: "thread.move.enqueue",
          commandId: CommandId.make("queue-move"),
          threadId,
          messageId: MessageId.make("move"),
          destination: { kind: "vm" },
          author: { userId: "owner", displayName: "Owner", imageUrl: null },
          createdAt: at,
        });
        const turnId = TurnId.make("native-turn");
        yield* runtime.upsert({
          threadId,
          providerName: "codex",
          providerInstanceId: instanceId,
          adapterKey: "codex",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt: at,
          resumeCursor: { threadId: "native-conversation" },
          runtimePayload: { activeTurnId: turnId },
        });
        let liveSessions: ReadonlyArray<ProviderSession> = [];
        let prepareCalls = 0;
        const history = makeThreadHistorySync(sql, engine, {
          append: () => Effect.void,
          confirmThrough: () => Effect.void,
        });
        const worker = yield* makeThreadLocalEnrollmentWorker(
          {
            abort: unused,
            receipts: unused,
            confirm: unused,
            prepare: () => {
              prepareCalls++;
              return Effect.fail(new ThreadMoveError({ threadId, detail: "Lost prepare reply" }));
            },
          },
          history,
        ).pipe(
          Effect.provideService(ProviderService, {
            ...provider,
            listSessions: () => Effect.succeed(liveSessions),
          }),
        );
        const owner = {
          threadId,
          projectId,
          environmentId: sourceId,
          relayUrl: "https://relay.test",
          generation: 1,
        };
        // An unprojected native turn is uncertain and cannot be ignored.
        expect(yield* worker.synchronize(threadId, owner)).toBe(false);
        expect(prepareCalls).toBe(0);
        yield* sql`INSERT INTO projection_turns
        (thread_id,turn_id,state,requested_at,completed_at,checkpoint_status,checkpoint_files_json)
        VALUES (${threadId},${turnId},'completed',${at},${at},'pending','[]')`;
        expect(yield* worker.synchronize(threadId, owner)).toBe(false);
        expect(prepareCalls).toBe(0);
        yield* sql`UPDATE projection_turns SET checkpoint_status='ready' WHERE thread_id=${threadId} AND turn_id=${turnId}`;
        liveSessions = [
          {
            threadId,
            provider: driverKind,
            providerInstanceId: instanceId,
            runtimeMode: "full-access",
            status: "running",
            activeTurnId: turnId,
            createdAt: at,
            updatedAt: at,
          },
        ];
        expect(yield* worker.synchronize(threadId, owner)).toBe(false);
        expect(prepareCalls).toBe(0);
        liveSessions = [
          {
            threadId,
            provider: driverKind,
            providerInstanceId: instanceId,
            runtimeMode: "full-access",
            status: "ready",
            createdAt: at,
            updatedAt: at,
          },
        ];
        yield* sql`INSERT INTO repository_workflow_jobs VALUES ('held',${threadId},'awaiting_review',0,'{}')`;
        const queued = yield* queue;
        const held = yield* Effect.flip(worker.synchronize(threadId, owner));
        expect(held._tag === "ThreadMoveError" ? held.detail : "").toContain("workflow");
        expect(prepareCalls).toBe(0);
        expect(yield* queue).toEqual(queued);
        expect(
          yield* sql`SELECT 1 FROM thread_local_enrollments WHERE thread_id=${threadId}`,
        ).toEqual([]);
        yield* sql`DELETE FROM repository_workflow_jobs`;
        const result = yield* Effect.result(worker.synchronize(threadId, owner));
        expect(prepareCalls).toBe(1);
        expect(result._tag).toBe("Failure");
        const [enrollment] = yield* sql<{
          phase: string;
        }>`SELECT phase FROM thread_local_enrollments WHERE thread_id=${threadId}`;
        expect(enrollment?.phase).toBe("pending");
        expect(yield* makeThreadExecutionFence(sql).get(threadId)).toBeNull();
      }).pipe(Effect.provide(environment(root)));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

for (const kind of ["terminal", "setup"] as const)
  it.effect(`explains unverified local ${kind} work once without claiming or starting a move`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "move-local-work-" }),
        );
        yield* Effect.gen(function* () {
          const engine = yield* OrchestrationEngineService;
          const sql = yield* SqlClient.SqlClient;
          const fences = makeThreadExecutionFence(sql);
          yield* engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("project"),
            projectId,
            title: "Local",
            workspaceRoot: root,
            createdAt: at,
          });
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("thread"),
            threadId,
            projectId,
            title: "Move",
            modelSelection: { instanceId, model: "gpt-5" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            worktreePath: null,
            createdAt: at,
          });
          yield* engine.dispatch({
            type: "thread.move.enqueue",
            commandId: CommandId.make("move"),
            threadId,
            messageId: MessageId.make("move"),
            destination: { kind: "vm" },
            author: { userId: "owner", displayName: "Owner", imageUrl: null },
            createdAt: at,
          });
          const owner = {
            threadId,
            projectId,
            environmentId: sourceId,
            relayUrl: "https://relay.test",
            generation: 3,
            operationId: "returned-local",
          };
          yield* fences.prepare(owner);
          yield* fences.activate(owner);
          yield* fences.beginWork({ ...owner, kind, workId: `${kind}:local-process` });
          const transport: ThreadMoveTransport = {
            sourceFormats: () => Effect.succeed(["launchpad-thread-chunks-v1"] as const),
            selectEncoding: unused,
            pending: unused,
            begin: unused,
            beginVm: unused,
            get: unused,
            progress: unused,
            failed: unused,
            freeze: unused,
            upload: unused,
            ready: unused,
            commit: unused,
            activate: unused,
            abort: unused,
            removed: unused,
            publish: unused,
            artifact: unused,
          };
          const worker = yield* makeThreadMoveWorker(
            transport,
            makeThreadHistorySync(sql, engine, { append: unused, confirmThrough: unused }),
            { synchronize: unused },
          ).pipe(Effect.provide(Layer.mock(TerminalManager)({ close: unused })));
          yield* sql`INSERT INTO repository_workflow_jobs VALUES ('held',${threadId},'awaiting_review',0,'{}')`;
          const queued = yield* queue;
          const held = yield* Effect.flip(worker.source(threadId));
          expect(held._tag === "ThreadMoveError" ? held.detail : "").toContain("workflow");
          expect(yield* queue).toEqual(queued);
          expect((yield* fences.get(threadId))?.phase).toBe("active");
          yield* sql`DELETE FROM repository_workflow_jobs`;
          yield* worker.source(threadId);
          const before = yield* queue;
          expect(before.entries[0]).toMatchObject({
            state: "pending",
            revision: 2,
            detail: expect.stringContaining("cannot confirm has stopped"),
          });
          const head = before.entries[0]!;
          expect(head.kind === "move" && head.operationId).toBeUndefined();
          expect(before.handoff).toBeNull();
          yield* worker.source(threadId);
          expect(yield* queue).toEqual(before);
          expect(yield* fences.get(threadId)).toMatchObject({
            phase: "active",
            generation: 3,
            operationId: "returned-local",
          });
          expect(
            yield* sql`SELECT 1 FROM thread_execution_work WHERE thread_id=${threadId} AND completed=0`,
          ).toHaveLength(1);
          yield* engine.dispatch({
            type: "thread.move.cancel",
            commandId: CommandId.make("cancel"),
            threadId,
            messageId: head.messageId,
            expectedRevision: head.revision,
            createdAt: at,
          });
          expect((yield* queue).entries).toEqual([]);
          yield* worker.source(threadId);
          expect((yield* fences.get(threadId))?.phase).toBe("active");
        }).pipe(Effect.provide(environment(root)));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

for (const reportFault of ["none", "lookup", "journal", "controller"] as const)
  it.effect(
    reportFault === "controller"
      ? "resumes VM download through the real guest auth controller without a client request"
      : reportFault === "none"
        ? "waits for the exact VM account without transfer work, resumes across worker restarts and cancels first"
        : `ends an auth-wait attempt before a lost failure report ${reportFault}`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.realPath(
            yield* fs.makeTempDirectoryScoped({ prefix: "move-auth-gate-" }),
          );
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const engine = yield* OrchestrationEngineService;
            const operationId = NodeCrypto.randomUUID();
            const owner = {
              threadId,
              operationId,
              environmentId: destinationId,
              generation: 2,
              relayUrl: "https://relay.test",
            };
            let move: RelayThreadMove = {
              operationId,
              threadId,
              actorUserId: "owner",
              sourceEnvironmentId: sourceId,
              expectedGeneration: 1,
              destinationEnvironmentId: destinationId,
              destinationProjectId: ProjectId.make(`vm:${threadId}`),
              phase: "frozen",
              sourceCursor: 1,
              manifestSha256: "a".repeat(64),
              manifestArtifactId: "00000000-0000-4000-8000-000000000001",
              recoveryVerified: true,
            };
            const reports: ThreadMoveProgressReport[] = [];
            const failures: { detail: string; attempt: number | undefined }[] = [];
            let downloads = 0;
            let loseFailureLookup = false,
              lookupReads = 0;
            const unexpected = () => Effect.die("Unexpected move work before authentication");
            const transport: ThreadMoveTransport = {
              sourceFormats: unexpected,
              selectEncoding: unexpected,
              pending: unexpected,
              beginVm: unexpected,
              begin: unexpected,
              get: () =>
                Effect.gen(function* () {
                  lookupReads++;
                  if (loseFailureLookup && lookupReads === 2) {
                    expect(
                      yield* sql`SELECT ended FROM thread_move_attempts WHERE operation_id=${operationId}`.pipe(
                        Effect.orDie,
                      ),
                    ).toEqual([{ ended: 1 }]);
                    return yield* new ThreadMoveError({ threadId, detail: "Failure lookup lost" });
                  }
                  return move;
                }),
              progress: (_owner, report) =>
                Effect.sync(() => {
                  reports.push(report);
                  return { accepted: true };
                }),
              failed: (_owner, detail, attempt) =>
                Effect.sync(() => {
                  failures.push({ detail, attempt });
                  return move;
                }),
              freeze: unexpected,
              upload: unexpected,
              publish: unexpected,
              artifact: () =>
                Effect.suspend(() => {
                  downloads++;
                  return Effect.fail(
                    new ThreadMoveError({ threadId, detail: "Authenticated download reached" }),
                  );
                }),
              ready: unexpected,
              commit: unexpected,
              activate: unexpected,
              abort: unexpected,
              removed: unexpected,
            };
            const history = makeThreadHistorySync(sql, engine, {
              append: () => Effect.void,
              confirmThrough: () => Effect.void,
            });
            let readiness: import("./ThreadVmProviderAuth.ts").ThreadVmAuthReadiness = {
              _tag: "Waiting",
              reason: "account_selection",
            };
            let authReads = 0;
            const personalWait =
              reportFault === "controller" ? "organization_connection" : "personal_sign_in";
            const makeController =
              reportFault === "controller"
                ? makeThreadVmProviderAuth.pipe(
                    Effect.provideService(ThreadVmCodexAuthContext, {
                      refresh: Effect.suspend(() => {
                        authReads++;
                        return readiness._tag === "Waiting"
                          ? Effect.fail(
                              new ThreadVmCodexAuthSourceError({
                                reason:
                                  readiness.reason === "account_selection"
                                    ? "account_selection_required"
                                    : "reconnect_required",
                              }),
                            )
                          : Effect.succeed(false);
                      }),
                      current: Effect.succeed({
                        connectionId: "org-connection",
                        label: "Organization Codex",
                        preflight: Effect.void,
                        status: Effect.succeed({
                          connectionId: "org-connection",
                          label: "Organization Codex",
                          status: "connected" as const,
                          epoch: 1,
                          tokenRevision: 1,
                          refreshing: false,
                          errorCode: null,
                        }),
                      }),
                      personalPreflight: Effect.void,
                      withReloadLock: (effect) => effect,
                      markApplied: Effect.void,
                    }),
                    Effect.provide(Layer.mock(ProviderAuthService)({})),
                  )
                : null;
            const realController = makeController ? yield* makeController : null;
            const vm = {
              operationId,
              environmentId: destinationId,
              relayUrl: owner.relayUrl,
              relayIssuer: owner.relayUrl,
              environmentCredential: "fixture-private-credential",
              cloudMintPublicKey: "fixture-key",
              scope: {
                allocationId: "allocation",
                threadId,
                repositoryId: "repository",
                generation: 2,
              },
            };
            const vmLayer = Layer.mergeAll(
              Layer.succeed(VmWorkloadTracking, true),
              Layer.succeed(ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(destinationId),
              }),
              Layer.mock(ServerSecretStore)({
                get: (key) =>
                  Effect.succeed(
                    key === THREAD_VM_IDENTITY_SECRET
                      ? Option.some(new TextEncoder().encode(JSON.stringify(vm)))
                      : Option.none(),
                  ),
              }),
              realController
                ? Layer.succeed(ThreadVmProviderAuth, realController)
                : Layer.mock(ThreadVmProviderAuth)({
                    readiness: (installed, binding) =>
                      Effect.sync(() => {
                        expect(installed).toEqual(vm);
                        expect(binding).toEqual({
                          operationId,
                          allocationId: "allocation",
                          environmentId: destinationId,
                          generation: 2,
                          instanceId: "codex",
                        });
                        authReads++;
                        return readiness;
                      }),
                  }),
            );
            const make = makeThreadMoveWorker(transport, history, {
              synchronize: () => Effect.void,
            }).pipe(Effect.provide(vmLayer));
            let worker = yield* make;
            yield* worker.destination(owner);
            expect(reports).toMatchObject([
              {
                attempt: 1,
                revision: 1,
                stage: "downloading",
                waitingForAuth: "account_selection",
              },
            ]);
            worker = yield* make;
            yield* worker.destination(owner);
            expect(reports).toHaveLength(1);
            readiness = { _tag: "Waiting", reason: personalWait };
            yield* worker.destination(owner);
            expect(reports).toMatchObject([
              { attempt: 1, revision: 1, waitingForAuth: "account_selection" },
              { attempt: 1, revision: 2, waitingForAuth: personalWait },
            ]);
            expect(downloads).toBe(0);
            expect(failures).toEqual([]);
            expect(yield* sql`SELECT 1 FROM thread_checkout_claims`).toEqual([]);
            expect(yield* sql`SELECT 1 FROM thread_transfer_baselines`).toEqual([]);
            expect(yield* sql`SELECT 1 FROM thread_transfer_readiness`).toEqual([]);
            let expectedWorkAttempt = 2;
            if (reportFault === "lookup" || reportFault === "journal") {
              readiness = { _tag: "Unavailable", message: "Sign-in verification unavailable" };
              lookupReads = 0;
              loseFailureLookup = reportFault === "lookup";
              if (reportFault === "journal")
                yield* sql`CREATE TEMP TRIGGER reject_attempt_end BEFORE UPDATE OF ended ON thread_move_attempts
                WHEN NEW.ended=1 BEGIN SELECT RAISE(ABORT,'attempt end unavailable'); END`;
              yield* Effect.flip(worker.destination(owner));
              expect(failures).toEqual([]);
              if (reportFault === "journal") {
                expect(lookupReads).toBe(1);
                yield* sql`DROP TRIGGER reject_attempt_end`;
                yield* Effect.flip(worker.destination(owner));
                expect(failures).toEqual([
                  { detail: "Sign-in verification unavailable", attempt: 1 },
                ]);
              }
              expect(
                yield* sql`SELECT ended FROM thread_move_attempts WHERE operation_id=${operationId}`,
              ).toEqual([{ ended: 1 }]);
              loseFailureLookup = false;
              readiness = { _tag: "Waiting", reason: "personal_sign_in" };
              worker = yield* make;
              yield* worker.destination(owner);
              expect(reports.at(-1)).toMatchObject({
                attempt: 2,
                revision: 1,
                waitingForAuth: "personal_sign_in",
              });
              expectedWorkAttempt = 3;
            }
            const previousAuthReads = authReads;
            readiness = { _tag: "Ready" };
            if (makeController)
              worker = yield* makeThreadMoveWorker(transport, history, {
                synchronize: () => Effect.void,
              }).pipe(
                Effect.provideService(ThreadVmProviderAuth, yield* makeController),
                Effect.provide(vmLayer),
              );
            yield* Effect.flip(worker.destination(owner));
            expect(downloads).toBe(1);
            expect(reports.at(-1)).toMatchObject({
              attempt: expectedWorkAttempt,
              stage: "downloading",
              waitingForAuth: null,
            });
            expect(failures.at(-1)).toEqual({
              detail: "Authenticated download reached",
              attempt: expectedWorkAttempt,
            });
            expect(authReads).toBe(previousAuthReads + 1);
            move = { ...move, phase: "aborting" };
            yield* Effect.flip(worker.destination(owner));
            expect(authReads).toBe(previousAuthReads + 1);
            expect(downloads).toBe(1);
            yield* makeThreadExecutionFence(sql).prepare({
              ...owner,
              projectId: move.destinationProjectId,
            });
            move = { ...move, phase: "ready" };
            const invalidReady = yield* Effect.flip(worker.destination(owner));
            expect(invalidReady).toMatchObject({
              _tag: "ThreadTransferReadinessError",
              message: expect.stringContaining("readiness"),
            });
            expect((yield* makeThreadExecutionFence(sql).get(threadId))?.phase).toBe("frozen");
            expect(authReads).toBe(previousAuthReads + 1);
            expect(downloads).toBe(1);
          }).pipe(Effect.provide(environment(root)));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
