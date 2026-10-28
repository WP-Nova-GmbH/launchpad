import { makeThreadHistorySync } from "./ThreadHistorySync.ts";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { activateRestoredThreadVm } from "./ThreadVmRestoreActivation.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  OrchestrationEvent,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { requireThreadVmRestoreServerStart } from "./ThreadVmServer.ts";
import {
  RelayThreadVmRestoreImportReceipt,
  RelayThreadVmRestoreRecovery,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { layer as SessionLayer } from "../persistence/ProviderSessionRuntime.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { ProcessRunner, layer as RunnerLayer } from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { exportCodexConversation } from "../provider/Drivers/CodexConversationTransfer.ts";
import { resolvePortableCodexHome } from "../provider/Drivers/PortableCodexHome.ts";
import { makeThreadNativeCheckpoint } from "./ThreadNativeCheckpoint.ts";
import { makeThreadAttachmentCheckpoint } from "./ThreadAttachmentCheckpoint.ts";
import { makeThreadNativeCheckpointTransfer } from "./ThreadNativeCheckpointTransfer.ts";
import { makeThreadAttachmentCheckpointTransfer } from "./ThreadAttachmentCheckpointTransfer.ts";
import { attachmentRelativePath } from "../attachmentStore.ts";
import { THREAD_VM_IDENTITY_SECRET } from "./ThreadVmEnrollment.ts";
import {
  installThreadVmRestoreRecovery,
  readThreadVmRestoreState,
  encodeThreadVmRestoreState,
  THREAD_VM_RESTORE_STATE_SECRET,
} from "./ThreadVmRestoreInstall.ts";

const encode = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeRestoreReceipt = Schema.encodeEffect(
  Schema.fromJsonString(RelayThreadVmRestoreImportReceipt),
);
const decodeNativeCursor = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      threadId: Schema.String,
      resumePolicy: Schema.String,
      portableStateId: Schema.String,
    }),
  ),
);
const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);
const decodeRecovery = Schema.decodeUnknownSync(RelayThreadVmRestoreRecovery);
const isRecovery = Schema.is(RelayThreadVmRestoreRecovery);
const at = "2026-10-07T00:00:00.000Z",
  nativeId = "01900000-0000-7000-8000-000000000001";
const fixture = Effect.fnUntraced(function* (worktree = false, ordinary = false) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    runner = yield* ProcessRunner;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "vm-restore-install-" }),
  );
  const baseDir = path.join(root, "serving"),
    workspaceRoot = path.join(root, "workspace");
  const operationId = NodeCrypto.randomUUID(),
    allocationId = NodeCrypto.randomUUID(),
    threadId = ThreadId.make(NodeCrypto.randomUUID());
  const oldBase = path.join(`${baseDir}-restores`, allocationId, "source"),
    oldDb = path.join(oldBase, "userdata", "state.sqlite");
  const git = Effect.fnUntraced(function* (cwd: string, args: ReadonlyArray<string>) {
    const result = yield* runner.run({
      command: "git",
      args: ["-c", "core.hooksPath=/dev/null", ...args],
      cwd,
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "0",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@local",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@local",
      },
    });
    if (result.code !== 0) throw new Error("fixture git failed");
    return result.stdout.trim();
  });
  yield* fs.makeDirectory(workspaceRoot);
  yield* git(workspaceRoot, ["init", "-b", "main"]);
  yield* fs.writeFileString(path.join(workspaceRoot, "README"), "committed\n");
  yield* git(workspaceRoot, ["add", "."]);
  yield* git(workspaceRoot, ["commit", "-m", "base"]);
  const checkoutPath = worktree ? path.join(baseDir, "worktrees", "saved-thread") : workspaceRoot;
  if (worktree) {
    yield* fs.makeDirectory(path.dirname(checkoutPath), { recursive: true });
    yield* git(workspaceRoot, ["worktree", "add", "-b", "work", checkoutPath]);
  }
  yield* fs.writeFileString(path.join(checkoutPath, "README"), "staged\n");
  yield* git(checkoutPath, ["add", "README"]);
  yield* fs.writeFileString(path.join(checkoutPath, "README"), "unstaged\n");
  yield* fs.writeFileString(path.join(checkoutPath, "untracked"), "keep me\n");
  const oldHome = path.join(oldBase, "codex"),
    rollout = path.join(oldHome, "sessions", `rollout-2026-10-07T00-00-00-${nativeId}.jsonl`);
  yield* fs.makeDirectory(path.dirname(rollout), { recursive: true });
  yield* fs.writeFileString(
    path.join(oldHome, "auth.json"),
    "old credential must remain quarantined",
  );
  yield* fs.writeFileString(
    rollout,
    encode({
      type: "session_meta",
      payload: { id: nativeId, cli_version: "0.159.3", history_mode: "paginated" },
    }) +
      "\n" +
      encode({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "remember the old conversation" }],
        },
      }) +
      "\n",
  );
  const sourceLayer = Layer.mergeAll(OrchestrationLayerLive, SessionLayer).pipe(
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(makeSqlitePersistenceLive(oldDb)),
    Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, oldBase)),
    Layer.provideMerge(RunnerLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const saved = yield* Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient,
        engine = yield* OrchestrationEngineService,
        events = yield* OrchestrationEventStore;
      const projectId = ProjectId.make("old-project");
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("project"),
        projectId,
        title: "Saved",
        workspaceRoot,
        createdAt: at,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("thread"),
        threadId,
        projectId,
        title: "Saved",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: worktree ? "work" : "main",
        worktreePath: worktree ? checkoutPath : null,
        createdAt: at,
      });
      const attachment = {
        type: "file" as const,
        id: `${threadId}-00000000-0000-4000-8000-000000000001-txt`,
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 9,
      };
      const attachmentsDir = path.join(oldBase, "userdata", "attachments");
      yield* fs.makeDirectory(attachmentsDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(attachmentsDir, attachmentRelativePath(attachment)!),
        "old notes",
      );
      const append = (type: string, payload: unknown) =>
        events.append(
          decodeEvent({
            sequence: 0,
            eventId: NodeCrypto.randomUUID(),
            type,
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: at,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload,
          }),
        );
      const message = yield* append("thread.message-sent", {
        threadId,
        messageId: "old-message",
        role: "user",
        text: "Remember",
        author: { userId: "author", displayName: "Saved Author", imageUrl: null },
        attachments: [attachment],
        turnId: null,
        streaming: false,
        createdAt: at,
        updatedAt: at,
      });
      if (!ordinary)
        yield* append("thread.prompt-queue-changed", {
          threadId,
          entry: {
            messageId: "later",
            text: "after restore",
            attachments: [attachment],
            runtimeMode: "full-access",
            interactionMode: "default",
            revision: 0,
            acceptedSequence: message.sequence,
            createdAt: at,
            state: "pending",
          },
          updatedAt: at,
        });
      yield* sql`INSERT INTO orchestration_command_receipts(command_id,aggregate_kind,aggregate_id,project_id,accepted_at,result_sequence,status,error)
      VALUES('original-command','thread',${threadId},${projectId},${at},${message.sequence},'accepted',NULL)`;
      const captureOperationId = NodeCrypto.randomUUID(),
        owner = {
          threadId,
          projectId,
          environmentId: "source",
          relayUrl: "https://relay.test",
          generation: 1,
          operationId: "initial",
        };
      const fences = makeThreadExecutionFence(sql);
      yield* fences.prepare(owner);
      yield* fences.activate(owner);
      if (!ordinary) {
        yield* fences.beginDrain({
          ...owner,
          operationId: captureOperationId,
          previousOperationId: "initial",
        });
        yield* fences.freeze({ ...owner, operationId: captureOperationId });
      }
      if (ordinary)
        yield* append("thread.session-set", {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            providerInstanceId: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: at,
          },
        });
      const native = yield* makeThreadNativeCheckpoint(sql).capture(
        {
          threadId,
          turnId: "settled",
          ...(ordinary ? {} : { captureOperationId }),
          artifactRoot: path.join(root, "native-outbox"),
        },
        (artifactRoot) =>
          exportCodexConversation({
            codexHome: oldHome,
            rolloutPath: rollout,
            threadId: nativeId,
            artifactRoot,
          }).pipe(
            Effect.map((archive) => ({
              directory: archive.directory,
              nativeThreadId: archive.manifest.threadId,
            })),
          ),
      );
      if (!native) throw new Error("missing native fixture");
      yield* makeThreadAttachmentCheckpoint(sql, events).capture({
        threadId,
        generation: 1,
        turnId: "settled",
        ...(ordinary ? {} : { captureOperationId }),
        artifactRoot: path.join(root, "chat-outbox"),
        attachmentsDir,
      });
      const packInput = {
        threadId,
        generation: 1,
        turnId: "settled",
        ...(ordinary ? {} : { captureOperationId }),
        sourceEnvironmentId: "source",
        scratchRoot: path.join(root, "packing"),
        chunkSizeBytes: 256,
      };
      const nativePacked = yield* makeThreadNativeCheckpointTransfer(sql, events).pack(packInput),
        chatPacked = yield* makeThreadAttachmentCheckpointTransfer(sql).pack(packInput);
      const history = yield* Stream.runCollect(
        events.readAggregateRange({
          aggregateKind: "thread",
          aggregateId: threadId,
          fromSequenceExclusive: 0,
          toSequenceInclusive: native.sourceSequence,
          limit: 10000,
        }),
      );
      if (ordinary)
        history.push(
          yield* append("thread.prompt-queue-changed", {
            threadId,
            entry: {
              messageId: "later",
              text: "after restore",
              attachments: [attachment],
              runtimeMode: "full-access",
              interactionMode: "default",
              revision: 0,
              acceptedSequence: native.sourceSequence + 1,
              createdAt: at,
              state: "pending",
            },
            updatedAt: at,
          }),
        );
      const receipts =
        yield* sql`SELECT command_id AS "commandId",aggregate_kind AS "aggregateKind",aggregate_id AS "aggregateId",project_id AS "projectId",accepted_at AS "acceptedAt",result_sequence AS "resultSequence",status,error FROM orchestration_command_receipts WHERE aggregate_id=${threadId} ORDER BY command_id`;
      return { native, nativePacked, chatPacked, attachment, history, receipts };
    }).pipe(Effect.provide(sourceLayer)),
  );
  const scope = { threadId, allocationId, repositoryId: "repository", generation: 2 },
    environmentId = EnvironmentId.make("fresh-environment");
  const recovery = decodeRecovery({
    operationId,
    savedDiskOperationId: saved.native.captureOperationId ?? NodeCrypto.randomUUID(),
    environmentId,
    scope,
    native: {
      ...saved.nativePacked.header,
      nativeThreadId: saved.native.nativeThreadId,
      manifestArtifactId: saved.nativePacked.artifactId,
      manifestSha256: saved.nativePacked.sha256,
    },
    attachments: {
      ...saved.chatPacked.header,
      manifestArtifactId: saved.chatPacked.artifactId,
      manifestSha256: saved.chatPacked.sha256,
    },
  });
  const objectPaths = new Map(
    [...saved.nativePacked.uploads, ...saved.chatPacked.uploads].map((part) => [
      part.artifactId,
      part.path,
    ]),
  );
  const requests: string[] = [];
  const readArtifact = (id: string) =>
    Effect.sync(() => {
      requests.push(id);
      const object = objectPaths.get(id);
      if (!object) throw new Error("missing fixture object");
      return fs.stream(object);
    });
  const destinationLayer = Layer.mergeAll(OrchestrationLayerLive, SessionLayer, Secrets.layer).pipe(
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(makeSqlitePersistenceLive(path.join(baseDir, "userdata", "state.sqlite"))),
    Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, baseDir)),
    Layer.provideMerge(RunnerLayer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(environmentId) }),
    ),
  );
  const seed = Effect.gen(function* () {
    yield* (yield* Secrets.ServerSecretStore).create(
      THREAD_VM_IDENTITY_SECRET,
      new TextEncoder().encode(
        encode({
          operationId,
          scope,
          environmentId,
          relayUrl: "https://relay.test",
          relayIssuer: "https://relay.test",
          environmentCredential: "fixture scoped key",
          cloudMintPublicKey: "fixture mint key",
        }),
      ),
    );
  });
  return {
    fs,
    path,
    root,
    baseDir,
    workspaceRoot,
    checkoutPath,
    threadId,
    operationId,
    recovery,
    destinationLayer,
    seed,
    requests,
    readArtifact,
    saved,
    oldDb,
    objectPaths,
    git,
  };
});

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    RunnerLayer.pipe(Layer.provide(NodeServices.layer)),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected fixture network")),
    ),
  ),
)("saved VM import", (it) => {
  for (const worktree of [false, true])
    it.effect(
      `independent backup import replaces snapshot app/native state and pauses the idle ready conversation in ${worktree ? "saved worktree" : "main checkout"}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(worktree, true);
            const events = f.saved.history.map((event, index) => ({
              ...event,
              sequence: index + 1,
            }));
            const digest = (body: Uint8Array) =>
              NodeCrypto.createHash("sha256").update(body).digest("hex");
            const eventBytes = new TextEncoder().encode(
              events.map((event) => encode(event) + "\n").join(""),
            );
            const receiptBytes = new TextEncoder().encode(
              f.saved.receipts
                .map((receipt) => encode({ ...receipt, resultSequence: events.length }) + "\n")
                .join(""),
            );
            const manifest = {
              format: "launchpad-history-v1",
              threadId: f.threadId,
              operationId: f.operationId,
              environmentId: "source",
              generation: 1,
              sourceSequence: events.length,
              eventCount: events.length,
              events: { sha256: digest(eventBytes), size: eventBytes.length },
              receiptCount: f.saved.receipts.length,
              receipts: { sha256: digest(receiptBytes), size: receiptBytes.length },
            };
            const header = new TextEncoder().encode(encode(manifest));
            const files = [];
            for (const [name, body] of [
              ["history/manifest.json", header],
              ["history/events.jsonl", eventBytes],
              ["history/receipts.jsonl", receiptBytes],
            ] as const) {
              const artifactId = NodeCrypto.randomUUID(),
                file = f.path.join(f.root, artifactId);
              yield* f.fs.writeFile(file, body);
              f.objectPaths.set(artifactId, file);
              files.push({
                path: name,
                sha256: digest(body),
                sizeBytes: body.length,
                chunks: body.length
                  ? [{ artifactId, sha256: digest(body), sizeBytes: body.length }]
                  : [],
              });
            }
            const index = new TextEncoder().encode(
              encode({
                format: "launchpad-thread-chunks-v1",
                threadId: f.threadId,
                operationId: f.operationId,
                sourceEnvironmentId: "source",
                generation: 1,
                transferManifestSha256: digest(header),
                files,
              }),
            );
            const manifestArtifactId = NodeCrypto.randomUUID(),
              file = f.path.join(f.root, manifestArtifactId);
            yield* f.fs.writeFile(file, index);
            f.objectPaths.set(manifestArtifactId, file);
            const { savedDiskOperationId: _disk, ...base } = f.recovery;
            const recovery = decodeRecovery({
              ...base,
              independentHistory: {
                manifestArtifactId,
                manifestSha256: digest(index),
                sequenceSpace: "relay-cursor-v1",
                nativeBoundary: {
                  checkpointOperationId: f.recovery.native.operationId,
                  sourceEnvironmentId: "source",
                  generation: 1,
                  sourceSequence: f.recovery.native.sourceSequence,
                  relayCursor: events.length - 1,
                },
                throughRelayCursor: events.length,
                throughCommandPosition: 0,
              },
            });
            expect(recovery.native.captureOperationId ?? null).toBeNull();
            expect(
              isRecovery({
                ...recovery,
                savedDiskOperationId: NodeCrypto.randomUUID(),
              }),
            ).toBe(false);
            expect(
              isRecovery({
                ...recovery,
                reset: {
                  canonicalKey: "github:example/repo",
                  branch: "main",
                  revision: "a".repeat(40),
                },
              }),
            ).toBe(false);
            const before = digest(yield* f.fs.readFile(f.oldDb));
            yield* Effect.gen(function* () {
              yield* f.seed;
              yield* Effect.flip(
                installThreadVmRestoreRecovery({
                  recovery: {
                    ...recovery,
                    independentHistory: {
                      ...recovery.independentHistory!,
                      nativeBoundary: {
                        ...recovery.independentHistory!.nativeBoundary,
                        sourceSequence: recovery.native.sourceSequence + 1,
                      },
                    },
                  },
                  readArtifact: f.readArtifact,
                  workspaceRoot: f.workspaceRoot,
                }),
              );
              yield* Effect.flip(
                installThreadVmRestoreRecovery({
                  recovery: {
                    ...recovery,
                    independentHistory: {
                      ...recovery.independentHistory!,
                      manifestSha256: "0".repeat(64),
                    },
                  },
                  readArtifact: f.readArtifact,
                  workspaceRoot: f.workspaceRoot,
                }),
              );
              const receipt = yield* installThreadVmRestoreRecovery({
                recovery,
                readArtifact: f.readArtifact,
                workspaceRoot: f.workspaceRoot,
              });
              expect(receipt.sourceSequence).toBe(f.recovery.native.sourceSequence);
              expect(receipt.checkoutPath).toBe(f.checkoutPath);
              const sql = yield* SqlClient.SqlClient;
              const [queue] = yield* sql<{
                state: string;
              }>`SELECT state_json AS state FROM projection_thread_prompt_queues WHERE thread_id=${f.threadId}`;
              expect(queue?.state).toContain('"enabled":false');
              expect(queue?.state).toContain('"messageId":"later"');
              const [session] =
                yield* sql`SELECT status,active_turn_id FROM projection_thread_sessions WHERE thread_id=${f.threadId}`;
              expect(session).toMatchObject({ status: "stopped", active_turn_id: null });
              const [notice] =
                yield* sql`SELECT kind FROM projection_thread_activities WHERE activity_id=${`thread-vm-backup:${f.operationId}:notice`}`;
              expect(notice?.kind).toBe("vm.backup-restored");
              expect(
                yield* installThreadVmRestoreRecovery({
                  recovery,
                  readArtifact: f.readArtifact,
                  workspaceRoot: f.workspaceRoot,
                }),
              ).toEqual(receipt);
              const [count] = yield* sql<{
                count: number;
              }>`SELECT count(*) AS count FROM orchestration_command_receipts WHERE command_id='original-command'`;
              expect(count?.count).toBe(1);
              expect((yield* makeThreadExecutionFence(sql).get(f.threadId))?.phase).toBe("frozen");
            }).pipe(Effect.provide(f.destinationLayer));
            expect(digest(yield* f.fs.readFile(f.oldDb))).toBe(before);
          }),
        ),
    );
  for (const worktree of [false, true])
    it.effect(
      `restores native history, authors, receipts and queued attachments while preserving the ${worktree ? "worktree" : "main checkout"}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(worktree),
              before = NodeCrypto.createHash("sha256")
                .update(yield* f.fs.readFile(f.oldDb))
                .digest("hex");
            const beforeIndex = yield* f.git(f.checkoutPath, ["diff", "--cached"]);
            yield* Effect.gen(function* () {
              yield* f.seed;
              const input = {
                recovery: f.recovery,
                readArtifact: f.readArtifact,
                workspaceRoot: f.workspaceRoot,
              };
              const receipt = yield* installThreadVmRestoreRecovery(input);
              expect(receipt.checkoutPath).toBe(f.checkoutPath);
              const receiptJson = yield* encodeRestoreReceipt(receipt);
              const digest = NodeCrypto.createHash("sha256").update(receiptJson).digest("hex");
              expect(yield* requireThreadVmRestoreServerStart(digest, f.workspaceRoot)).toEqual(
                receipt,
              );
              yield* Effect.flip(
                requireThreadVmRestoreServerStart("0".repeat(64), f.workspaceRoot),
              );
              const snapshot = yield* (yield* ProjectionSnapshotQuery).getSnapshot();
              expect(snapshot.threads).toHaveLength(1);
              expect(snapshot.threads[0]?.messages[0]?.author?.displayName).toBe("Saved Author");
              expect(snapshot.threads[0]?.worktreePath).toBe(worktree ? f.checkoutPath : null);
              const sql = yield* SqlClient.SqlClient;
              expect(
                yield* sql`SELECT command_id FROM orchestration_command_receipts WHERE command_id='original-command'`,
              ).toHaveLength(1);
              expect((yield* makeThreadExecutionFence(sql).get(f.threadId))?.phase).toBe("frozen");
              const state = yield* readThreadVmRestoreState();
              expect(state?.phase).toBe("installed");
              const [runtime] = yield* sql<{
                cursor: string;
              }>`SELECT resume_cursor_json AS cursor FROM provider_session_runtime WHERE thread_id=${f.threadId}`;
              const cursor = yield* decodeNativeCursor(runtime!.cursor);
              expect(cursor.resumePolicy).toBe("require-existing");
              expect(cursor.threadId).toBe(nativeId);
              const portable = yield* resolvePortableCodexHome({
                stateDir: (yield* ServerConfig).stateDir,
                threadId: f.threadId,
                providerInstanceId: "codex",
                nativeThreadId: nativeId,
                portableStateId: cursor.portableStateId,
              });
              expect(yield* f.fs.exists(f.path.join(portable.homePath, "auth.json"))).toBe(false);
              expect(
                yield* f.fs.readFileString(
                  f.path.join(
                    (yield* ServerConfig).attachmentsDir,
                    attachmentRelativePath(f.saved.attachment)!,
                  ),
                ),
              ).toBe("old notes");
              yield* sql`UPDATE provider_session_runtime SET status='running' WHERE thread_id=${f.threadId}`;
              yield* Effect.flip(requireThreadVmRestoreServerStart(digest, f.workspaceRoot));
              yield* sql`UPDATE provider_session_runtime SET status='stopped' WHERE thread_id=${f.threadId}`;
              const count = f.requests.length;
              expect(yield* installThreadVmRestoreRecovery(input)).toEqual(receipt);
              expect(f.requests).toHaveLength(count);
              yield* Effect.flip(
                (yield* OrchestrationEngineService).dispatch({
                  type: "thread.meta.update",
                  commandId: CommandId.make("too-soon"),
                  threadId: f.threadId,
                  title: "Must remain blocked",
                }),
              );
              const secrets = yield* Secrets.ServerSecretStore;
              yield* secrets.set(
                THREAD_VM_RESTORE_STATE_SECRET,
                new TextEncoder().encode(
                  yield* encodeThreadVmRestoreState({ ...state!, phase: "ready" }),
                ),
              );
              // Startup proof uses a verified readiness receipt; provider/setup
              // execution itself has separate real adapter-boundary tests.
              yield* sql`INSERT INTO thread_transfer_readiness(operation_id,manifest_sha256,native_runtime_json,setup_sha256,phase)
                  SELECT operation_id,manifest_sha256,native_runtime_json,${"0".repeat(64)},'ready' FROM thread_transfer_baselines WHERE operation_id=${f.operationId}`;
              let calls = 0,
                ready = false,
                status = 200;
              const client = HttpClient.make((request) =>
                Effect.gen(function* () {
                  if (request.url.endsWith("/repository/binding"))
                    return HttpClientResponse.fromWeb(
                      request,
                      Response.json({
                        operationId: f.operationId,
                        environmentId: receipt.environmentId,
                        repositoryId: receipt.scope.repositoryId,
                        threadId: f.threadId,
                        generation: receipt.scope.generation,
                        canonicalKey: "github.com/acme/project",
                      }),
                    );
                  calls++;
                  expect(request.url).toBe(
                    `https://relay.test/v1/environments/fresh-environment/threads/${f.threadId}/restore/activate`,
                  );
                  expect(
                    (yield* makeThreadExecutionFence(sql).get(f.threadId).pipe(Effect.orDie))
                      ?.phase,
                  ).toBe("frozen");
                  return HttpClientResponse.fromWeb(request, Response.json({ ready }, { status }));
                }),
              );
              const activate = activateRestoredThreadVm(f.threadId).pipe(
                Effect.provideService(HttpClient.HttpClient, client),
                Effect.provide(
                  Layer.mock(ProviderInstanceRegistry)({
                    getInstance: () => Effect.die("Ready restore must not replay setup"),
                  }),
                ),
              );
              expect(yield* activate).toBe(false);
              expect((yield* makeThreadExecutionFence(sql).get(f.threadId))?.phase).toBe("frozen");
              status = 503;
              yield* Effect.flip(activate);
              status = 200;
              ready = true;
              yield* Effect.flip(
                activate.pipe(
                  Effect.provideService(Secrets.ServerSecretStore, {
                    ...secrets,
                    set: () =>
                      Effect.fail(
                        new Secrets.SecretStorePersistError({
                          resource: "restore-state",
                          cause: "fixture write failure",
                        }),
                      ),
                  }),
                ),
              );
              expect((yield* makeThreadExecutionFence(sql).get(f.threadId))?.phase).toBe("frozen");
              expect((yield* readThreadVmRestoreState())?.phase).toBe("ready");
              expect(yield* activate).toBe(true);
              expect(calls).toBe(4);
              expect(yield* f.git(f.checkoutPath, ["remote", "get-url", "origin"])).toBe(
                "https://github.com/acme/project.git",
              );
              expect(yield* f.git(f.checkoutPath, ["config", "--get", "commit.gpgsign"])).toBe(
                "false",
              );
              expect((yield* readThreadVmRestoreState())?.phase).toBe("activated");
              expect((yield* makeThreadExecutionFence(sql).get(f.threadId))?.phase).toBe("active");
              expect(yield* activate).toBe(false);
              expect(calls).toBe(4);
              yield* sql`UPDATE provider_session_runtime SET status='running' WHERE thread_id=${f.threadId}`;
              expect(yield* requireThreadVmRestoreServerStart(digest, f.workspaceRoot)).toEqual(
                receipt,
              );
            }).pipe(Effect.provide(f.destinationLayer));
            expect(
              NodeCrypto.createHash("sha256")
                .update(yield* f.fs.readFile(f.oldDb))
                .digest("hex"),
            ).toBe(before);
            expect(yield* f.git(f.checkoutPath, ["diff", "--cached"])).toBe(beforeIndex);
            expect(yield* f.fs.readFileString(f.path.join(f.checkoutPath, "README"))).toBe(
              "unstaged\n",
            );
            expect(yield* f.fs.readFileString(f.path.join(f.checkoutPath, "untracked"))).toBe(
              "keep me\n",
            );
          }),
        ),
    );
  it.effect("blocks a changed recovery scope before downloads or project creation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          yield* f.seed;
          yield* Effect.flip(
            installThreadVmRestoreRecovery({
              recovery: { ...f.recovery, operationId: NodeCrypto.randomUUID() },
              readArtifact: f.readArtifact,
              workspaceRoot: f.workspaceRoot,
            }),
          );
          expect(f.requests).toHaveLength(0);
          expect((yield* (yield* ProjectionSnapshotQuery).getSnapshot()).projects).toHaveLength(0);
        }).pipe(Effect.provide(f.destinationLayer));
      }),
    ),
  );
  it.effect("blocks a corrupted independent native index without writing a baseline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          yield* f.seed;
          yield* Effect.flip(
            installThreadVmRestoreRecovery({
              recovery: {
                ...f.recovery,
                native: { ...f.recovery.native, manifestSha256: "0".repeat(64) },
              },
              readArtifact: f.readArtifact,
              workspaceRoot: f.workspaceRoot,
            }),
          );
          expect(f.requests).toEqual([f.recovery.native.manifestArtifactId]);
          expect((yield* (yield* ProjectionSnapshotQuery).getSnapshot()).threads).toHaveLength(0);
          expect(yield* readThreadVmRestoreState()).toBeNull();
        }).pipe(Effect.provide(f.destinationLayer));
      }),
    ),
  );
});

it.effect(
  "Reset VM imports the retained conversation into a fresh checkout without its expired disk",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture(),
          runner = yield* ProcessRunner;
        const revision = yield* f.git(f.workspaceRoot, ["rev-parse", "HEAD"]);
        const source = f.path.join(f.root, "reset-source");
        yield* f.fs.rename(f.workspaceRoot, source);
        yield* f.fs.remove(`${f.baseDir}-restores`, { recursive: true });
        const bundlePath = f.path.join(f.root, "uploaded-repository.bundle");
        yield* f.git(source, ["update-ref", "refs/t3/transfer/head", revision]);
        yield* f.git(source, ["bundle", "create", bundlePath, "refs/t3/transfer/head"]);
        const bundle = yield* f.fs.readFile(bundlePath);
        const artifactId = NodeCrypto.randomUUID();
        const sha256 = NodeCrypto.createHash("sha256").update(bundle).digest("hex");
        const recovery = decodeRecovery({
          ...f.recovery,
          reset: {
            canonicalKey: "github.com/test/reset",
            branch: "main",
            revision,
            repositoryUpload: {
              operationId: NodeCrypto.randomUUID(),
              threadId: f.threadId,
              sourceEnvironmentId: f.recovery.native.sourceEnvironmentId,
              generation: f.recovery.native.generation,
              branch: "main",
              revision,
              objectFormat: "sha1",
              bundle: {
                sha256,
                sizeBytes: bundle.length,
                chunks: [{ artifactId, sha256, sizeBytes: bundle.length }],
              },
            },
          },
        });
        const calls: string[] = [];
        const uploadRunner: typeof ProcessRunner.Service = {
          run: (request) =>
            Effect.gen(function* () {
              calls.push(request.command);
              if (request.command === "codex")
                return {
                  code: ChildProcessSpawner.ExitCode(request.args[0] === "login" ? 1 : 0),
                  stdout: request.args[0] === "--version" ? "codex-cli 0.159.3" : "",
                  stderr: "",
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              expect(request.args.some((arg) => arg.startsWith("https://"))).toBe(false);
              return yield* runner.run(request);
            }),
        };
        const readArtifact = (id: string) =>
          id === artifactId ? Effect.succeed(Stream.fromIterable([bundle])) : f.readArtifact(id);
        yield* Effect.gen(function* () {
          yield* f.seed;
          const input = { recovery, readArtifact, workspaceRoot: f.workspaceRoot };
          const receipt = yield* installThreadVmRestoreRecovery(input);
          expect(receipt.revision).toBe(revision);
          expect(receipt.repositoryBundleSha256).toBe(sha256);
          expect(receipt.branch).toBe("main");
          expect(yield* f.fs.readFileString(f.path.join(f.workspaceRoot, "README"))).toBe(
            "committed\n",
          );
          expect(calls.includes("bash")).toBe(false);
          const snapshot = yield* (yield* ProjectionSnapshotQuery).getSnapshot();
          const thread = snapshot.threads[0]!;
          expect(thread.messages[0]?.author?.displayName).toBe("Saved Author");
          expect(thread.promptQueue?.entries).toHaveLength(1);
          expect(thread.promptQueue?.enabled).toBe(false);
          expect(thread.activities.filter((activity) => activity.kind === "vm.reset")).toHaveLength(
            1,
          );
          expect(
            (yield* makeThreadExecutionFence(yield* SqlClient.SqlClient).get(f.threadId))?.phase,
          ).toBe("frozen");
          expect(yield* installThreadVmRestoreRecovery(input)).toEqual(receipt);
          const retry = yield* (yield* ProjectionSnapshotQuery).getSnapshot();
          expect(
            retry.threads[0]?.activities.filter((activity) => activity.kind === "vm.reset"),
          ).toHaveLength(1);
          expect((yield* readThreadVmRestoreState())?.phase).toBe("installed");
          const mirrored: OrchestrationEvent[] = [];
          const sync = makeThreadHistorySync(
            yield* SqlClient.SqlClient,
            yield* OrchestrationEngineService,
            {
              append: (_owner, event) =>
                Effect.sync(() => {
                  mirrored.push(event);
                }),
              confirmThrough: () => Effect.void,
            },
          );
          yield* sync.synchronize(f.threadId);
          expect(mirrored.map((event) => event.type)).toEqual([
            "thread.prompt-queue-changed",
            "thread.activity-appended",
            "thread.placement-imported",
          ]);
          expect(
            mirrored.filter(
              (event) => event.eventId === `thread-vm-reset:${recovery.operationId}:notice`,
            ),
          ).toHaveLength(1);
          yield* sync.synchronize(f.threadId);
          expect(mirrored).toHaveLength(3);
        }).pipe(
          Effect.provideService(ProcessRunner, uploadRunner),
          Effect.provide(f.destinationLayer),
        );
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, RunnerLayer.pipe(Layer.provide(NodeServices.layer))),
      ),
    ),
);
