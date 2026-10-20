import * as HttpClient from "effect/unstable/http/HttpClient";
import { makeThreadLocalEnrollmentWorker } from "./ThreadLocalEnrollmentWorker.ts";
import { RelayOrganizationId, RelayRepositoryId } from "@t3tools/contracts/relay";
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
} from "@t3tools/contracts";
import type { RelayThreadMove } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  layer as SessionLayer,
  ProviderSessionRuntimeRepository,
} from "../persistence/ProviderSessionRuntime.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { ProcessRunner, layer as RunnerLayer } from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { makeThreadHistorySync } from "./ThreadHistorySync.ts";
import { ThreadMoveError, type ThreadMoveTransport } from "./ThreadMoveTransport.ts";
import { makeThreadMoveWorker } from "./ThreadMoveWorker.ts";
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
          return makeThreadExecutionRelay(yield* SqlClient.SqlClient, {
            admit: () => Effect.succeed({ completed: false, newlyAdmitted: true }),
            complete: () => Effect.void,
          });
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
const queue = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    state: string;
  }>`SELECT state_json AS state FROM projection_thread_prompt_queues WHERE thread_id=${threadId}`;
  return yield* decodeQueue(row!.state);
});

for (const lost of [
  "published",
  "recovery-publish",
  "recovery-ready",
  "parallel-transfer",
  "upload",
  "commit",
  "activate",
  "cancel-setup",
  "cancel-edit",
  "cancel-uncertain",
  "enroll-prepare",
  "enroll-receipts",
  "enroll-confirm",
  "enroll-cancel-prepare",
] as const)
  it.effect(
    lost === "published"
      ? "keeps a published move frozen without uploading the archive again after a restart"
      : lost === "parallel-transfer"
        ? "moves files in bounded parallel transfers and publishes only after every upload completes"
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
          if (lost.startsWith("enroll-"))
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
          yield* fs.writeFileString(path.join(src, "README"), "uncommitted work\n");
          if (lost === "parallel-transfer")
            for (let i = 0; i < 8; i++)
              yield* fs.writeFileString(path.join(src, `dirty-${i}`), `unsaved work ${i}\n`);
          const uploadGate = yield* Deferred.make<void>();
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
            commits = 0;
          const failure = () => new ThreadMoveError({ threadId, detail: "Lost relay reply" });
          const current = Effect.suspend(() =>
            remote ? Effect.succeed(remote) : Effect.fail(failure()),
          );
          const transport: ThreadMoveTransport = {
            pending: () => Effect.succeed({ entries: [], next: null }),
            beginVm: () => Effect.die("Unexpected VM creation"),
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
                    destinationProjectId: projectId,
                    phase: "preparing",
                    sourceCursor: null,
                    manifestSha256: null,
                  }),
              ),
            get: () => current,
            freeze: (_owner, input) =>
              Effect.sync(() => (remote = { ...remote!, ...input, phase: "frozen" })),
            upload: (owner, file, body) =>
              Effect.gen(function* () {
                activeUploads++;
                maximumUploads = Math.max(maximumUploads, activeUploads);
                uploadStarts++;
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
                      if (lost === "upload" && !lostReply) {
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
                if ((lost === "recovery-publish" || lost === "recovery-ready") && !lostReply) {
                  lostReply = true;
                  return yield* failure();
                }
                remote = { ...remote, recoveryVerified: true };
                return { manifestArtifactId: id, artifactCount: uploads.size };
              }),
            artifact: (_owner, id) => {
              const bytes = uploads.get(id);
              if (!bytes) return Effect.fail(failure());
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
            ready: () => Effect.sync(() => (remote = { ...remote!, phase: "ready" })),
            commit: () =>
              Effect.gen(function* () {
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
            abort: () => Effect.sync(() => (remote = { ...remote!, phase: "aborting" })),
            removed: () => Effect.sync(() => (remote = { ...remote!, phase: "aborted" })),
          };
          yield* Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService,
              sql = yield* SqlClient.SqlClient,
              fences = makeThreadExecutionFence(sql);
            yield* engine.dispatch({
              type: "project.create",
              commandId: CommandId.make("source-project"),
              projectId,
              title: "Source",
              workspaceRoot: src,
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
              destination: { kind: "environment", environmentId: destinationId, projectId },
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
            if (lost === "recovery-publish" || lost === "recovery-ready") {
              expect((yield* Effect.flip(source.source(threadId)))._tag).toBe("ThreadMoveError");
              expect(remote?.manifestArtifactId).not.toBeNull();
              const completedUploads = uploadStarts;
              if (lost === "recovery-ready") remote = { ...remote!, phase: "ready" };
              source = yield* makeThreadMoveWorker(transport, history, commands);
              yield* source.source(threadId);
              expect(uploadStarts).toBe(completedUploads);
              expect(remote?.recoveryVerified).toBe(true);
            }
            if (lost === "upload") {
              expect((yield* Effect.flip(source.source(threadId)))._tag).toBe("ThreadMoveError");
              expect(activeUploads).toBe(0);
              expect(remote?.manifestArtifactId).toBeNull();
              expect((yield* fences.get(threadId))?.phase).toBe("frozen");
              expect((yield* queue).entries.map((entry) => entry.messageId)).toEqual([
                "move",
                "prompt",
              ]);
              source = yield* makeThreadMoveWorker(transport, history, commands);
            }
            yield* source.source(threadId);
            expect(remote?.phase).toBe(lost === "recovery-ready" ? "committed" : "frozen");
            expect(remote?.manifestArtifactId).not.toBeNull();
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
              yield* destinationEngine.dispatch({
                type: "project.create",
                commandId: CommandId.make("destination-project"),
                projectId,
                title: "Destination",
                workspaceRoot: dst,
                createdAt: at,
              });
              const destinationHistory = makeThreadHistorySync(destinationSql, destinationEngine, {
                append: () => Effect.void,
                confirmThrough: () => Effect.void,
              });
              let destination = yield* makeThreadMoveWorker(
                transport,
                destinationHistory,
                commands,
              );
              const owner = {
                threadId,
                environmentId: destinationId,
                relayUrl: enrolled.relayUrl,
                generation: 2,
                operationId: remote!.operationId,
              };
              if (lost.startsWith("cancel-")) {
                expect((yield* Effect.flip(destination.destination(owner)))._tag).toBe(
                  "ThreadTransferReadinessError",
                );
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
              if (lost === "commit" || lost === "activate") {
                yield* Effect.flip(destination.destination(owner));
                expect((yield* destinationFences.get(threadId))?.phase).toBe("frozen");
                yield* Effect.flip(
                  destinationFences.beginWork({
                    threadId,
                    generation: 2,
                    workId: "premature",
                    kind: "provider",
                  }),
                );
                destination = yield* makeThreadMoveWorker(transport, destinationHistory, commands);
              }
              yield* destination.destination(owner);
              expect(remote?.phase).toBe("completed");
              expect((yield* destinationFences.get(threadId))?.phase).toBe("active");
              expect((yield* queue).entries.map((entry) => entry.messageId)).toEqual(["prompt"]);
              expect(yield* fs.readFileString(path.join(dst, "README"))).toBe("uncommitted work\n");
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
              pending: unused,
              begin: unused,
              get: unused,
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
            pending: unused,
            begin: unused,
            beginVm: unused,
            get: unused,
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
