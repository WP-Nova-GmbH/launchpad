import { makeThreadAttachmentCheckpoint } from "./ThreadAttachmentCheckpoint.ts";
import { makeThreadNativeCheckpoint } from "./ThreadNativeCheckpoint.ts";
import { exportCodexConversation } from "../provider/Drivers/CodexConversationTransfer.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import { OrchestrationEvent, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import { ThreadTransferChunkManifest } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import {
  ProviderSessionRuntimeRepository,
  layer as SessionLayer,
} from "../persistence/ProviderSessionRuntime.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { ProcessRunner, layer as RunnerLayer } from "../processRunner.ts";
import { makeThreadTransferArchive, stageThreadTransferArchive } from "./ThreadTransferArchive.ts";
import {
  materializeThreadTransferChunks,
  packThreadTransferArchive,
} from "./ThreadTransferChunks.ts";
import { attachmentRelativePath } from "../attachmentStore.ts";

const at = "2026-10-05T10:00:00.000Z";
const nativeId = "00000000-0000-4000-8000-000000000001";
const decode = Schema.decodeUnknownSync(OrchestrationEvent);
const decodeChunks = Schema.decodeSync(Schema.fromJsonString(ThreadTransferChunkManifest));
const json = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
let serial = 0;
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    sql = yield* SqlClient.SqlClient;
  const events = yield* OrchestrationEventStore,
    sessions = yield* ProviderSessionRuntimeRepository,
    runner = yield* ProcessRunner;
  const threadId = ThreadId.make(`transfer-${++serial}`),
    projectId = `project-${serial}`;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "thread-transfer-archive-" }),
  );
  const workspace = path.join(root, "workspace"),
    codexHome = path.join(root, "provider"),
    attachmentsDir = path.join(root, "attachments");
  yield* fs.makeDirectory(workspace);
  yield* fs.makeDirectory(path.join(codexHome, "sessions"), { recursive: true });
  yield* fs.makeDirectory(attachmentsDir);
  const git = (args: ReadonlyArray<string>) =>
    runner
      .run({
        command: "git",
        args: ["-c", "core.hooksPath=/dev/null", ...args],
        cwd: workspace,
        env: {
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_COUNT: "0",
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@localhost",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@localhost",
        },
      })
      .pipe(Effect.tap((result) => Effect.sync(() => expect(result.code).toBe(0))));
  yield* git(["init", "-b", "main"]);
  yield* fs.writeFileString(path.join(workspace, "README"), "workspace bytes\n");
  yield* git(["add", "."]);
  yield* git(["commit", "-m", "fixture"]);
  const rolloutPath = path.join(
    codexHome,
    "sessions",
    `rollout-2026-10-05T10-00-00-${nativeId}.jsonl`,
  );
  yield* fs.writeFileString(
    rolloutPath,
    `${json({ type: "session_meta", payload: { id: nativeId, cli_version: "0.159.3", history_mode: "paginated" } })}\n${json({ type: "event_msg", payload: { type: "user_message", message: "conversation-only fact" } })}\n`,
  );
  yield* fs.writeFileString(path.join(codexHome, "auth.json"), "must never copy authentication");
  const attachment = {
    type: "file" as const,
    id: `${threadId}-00000000-0000-4000-8000-000000000002-txt`,
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
  };
  yield* fs.writeFileString(
    path.join(attachmentsDir, attachmentRelativePath(attachment)!),
    "notes",
  );
  const base = {
    sequence: 0,
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: at,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  };
  yield* events.append(
    decode({
      ...base,
      type: "thread.created",
      eventId: `${threadId}-create`,
      payload: {
        threadId,
        projectId,
        title: "Transfer",
        modelSelection: { provider: "codex", model: "gpt-5", instanceId: "codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        createdAt: at,
        updatedAt: at,
      },
    }),
  );
  yield* events.append(
    decode({
      ...base,
      type: "thread.message-sent",
      eventId: `${threadId}-message`,
      payload: {
        threadId,
        messageId: "message",
        role: "user",
        text: "message",
        attachments: [attachment],
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
    }),
  );
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Project', ${workspace}, '[]', ${at}, ${at})`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
    VALUES (${threadId}, ${projectId}, 'Thread', '{"provider":"codex","model":"gpt-5","instanceId":"codex"}', 'full-access', 'default', ${at}, ${at})`;
  const runtime = {
    threadId,
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    adapterKey: "codex",
    runtimeMode: "full-access" as const,
    status: "stopped" as const,
    lastSeenAt: at,
    resumeCursor: { threadId: nativeId },
    runtimePayload: null,
  };
  yield* sessions.upsert(runtime);
  const fences = makeThreadExecutionFence(sql);
  const owner = { threadId, environmentId: "source", generation: 1, operationId: "move" };
  const enrollment = {
    ...owner,
    operationId: "enroll",
    relayUrl: "https://relay.example",
    projectId,
  };
  yield* fences.prepare(enrollment);
  yield* fences.activate(enrollment);
  yield* fences.beginDrain({ ...owner, previousOperationId: "enroll" });
  yield* fences.freeze(owner);
  const archive = makeThreadTransferArchive(sql, events);
  const input = {
    ...owner,
    artifactRoot: path.join(root, "artifacts"),
    attachmentsDir,
    serverDataRoot: root,
    native: { codexHome, rolloutPath },
  };
  const request = (saved: Effect.Success<ReturnType<typeof archive.exportFrozen>>) => ({
    owner,
    expectedSha256: saved.sha256,
    artifactDirectory: saved.directory,
    destinationRoot: path.join(root, "destination"),
    codexVersion: "0.159.3",
  });
  return {
    fs,
    path,
    root,
    runner,
    sql,
    events,
    sessions,
    runtime,
    fences,
    owner,
    workspace,
    codexHome,
    rolloutPath,
    attachmentsDir,
    archive,
    input,
    request,
  };
});
const layer = Layer.mergeAll(OrchestrationEventStoreLive, SessionLayer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.merge(RunnerLayer),
  Layer.provideMerge(NodeServices.layer),
);
it.layer(layer)("whole thread transfer archive", (it) => {
  it.effect(
    "a coordinated move reuses exact frozen native files even when their workspace originals have changed",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture,
          sql = yield* SqlClient.SqlClient,
          operationId = NodeCrypto.randomUUID();
        yield* sql`UPDATE thread_execution_fences SET operation_id=${operationId} WHERE thread_id=${f.owner.threadId}`;
        const image = f.path.join(f.workspace, "input.png"),
          original = new Uint8Array([137, 80, 78, 71]);
        yield* f.fs.writeFile(image, original);
        yield* f.fs.writeFileString(
          f.rolloutPath,
          (yield* f.fs.readFileString(f.rolloutPath)) +
            json({ type: "event_msg", payload: { type: "view_image_tool_call", path: image } }) +
            "\n",
        );
        const turnId = "settled-turn";
        yield* makeThreadNativeCheckpoint(sql).captureFrozen(
          {
            threadId: f.owner.threadId,
            turnId,
            operationId,
            artifactRoot: f.path.join(f.root, "checkpoint"),
          },
          (artifactRoot) =>
            exportCodexConversation({
              codexHome: f.codexHome,
              rolloutPath: f.rolloutPath,
              threadId: nativeId,
              artifactRoot,
              referencedFileRoots: [f.workspace, f.attachmentsDir],
            }).pipe(
              Effect.map((archive) => ({ directory: archive.directory, nativeThreadId: nativeId })),
            ),
        );
        yield* makeThreadAttachmentCheckpoint(sql, yield* OrchestrationEventStore).capture({
          threadId: f.owner.threadId,
          generation: 1,
          turnId,
          captureOperationId: operationId,
          artifactRoot: f.path.join(f.root, "chat-checkpoint"),
          attachmentsDir: f.attachmentsDir,
        });
        const attachmentName = (yield* f.fs.readDirectory(f.attachmentsDir))[0]!;
        yield* f.fs.writeFileString(f.path.join(f.attachmentsDir, attachmentName), "other");
        yield* f.fs.writeFile(image, new Uint8Array([0, 0, 0, 0]));
        yield* sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,completed_at,checkpoint_files_json)
          VALUES(${f.owner.threadId},${turnId},'completed',${at},${at},'[]')`;
        const checkpointConversation = Effect.gen(function* () {
          yield* makeThreadNativeCheckpoint(sql).captureFrozen(
            {
              threadId: f.owner.threadId,
              turnId,
              operationId,
              artifactRoot: f.path.join(f.root, "checkpoint"),
            },
            () => Effect.die("Frozen retries must not re-export changed native sources"),
          );
          yield* makeThreadAttachmentCheckpoint(sql, yield* OrchestrationEventStore).capture({
            threadId: f.owner.threadId,
            generation: 1,
            turnId,
            captureOperationId: operationId,
            artifactRoot: f.path.join(f.root, "chat-checkpoint"),
            attachmentsDir: f.attachmentsDir,
          });
        }).pipe(
          Effect.provideService(OrchestrationEventStore, yield* OrchestrationEventStore),
          Effect.provideService(FileSystem.FileSystem, f.fs),
          Effect.provideService(Path.Path, f.path),
          Effect.orDie,
        );
        const saved = yield* f.archive.exportSource(
          {
            ...f.input,
            operationId,
          },
          {
            listSessions: () => Effect.succeed([]),
            checkpointConversation: () => checkpointConversation,
          },
        );
        expect(
          yield* f.fs.readFileString(f.path.join(saved.directory, "attachments", attachmentName)),
        ).toBe("notes");
        const file = saved.manifest.native?.files?.find((file) => file.sourcePath === image);
        expect(file).toBeDefined();
        expect(
          Array.from(
            yield* f.fs.readFile(f.path.join(saved.directory, "native", "files", file!.name)),
          ),
        ).toEqual(Array.from(original));
        yield* stageThreadTransferArchive({
          ...f.request(saved),
          owner: { ...f.owner, operationId },
        });
      }),
  );
  it.effect("native references retain only attachments in this thread's frozen history", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const own = (yield* f.fs.readDirectory(f.attachmentsDir))[0]!;
      const root = yield* f.fs.realPath(f.attachmentsDir);
      const original = yield* f.fs.readFileString(f.rolloutPath);
      yield* f.fs.writeFileString(
        f.rolloutPath,
        original +
          json({
            type: "event_msg",
            payload: { type: "view_image_tool_call", path: f.path.join(root, own) },
          }) +
          "\n",
      );
      const exported = yield* f.archive.exportFrozen(f.input);
      expect(exported.manifest.native?.files).toHaveLength(1);
      const staged = yield* stageThreadTransferArchive(f.request(exported));
      expect(yield* f.fs.readFileString(staged.native!.rolloutPath)).toContain(
        staged.native!.homePath,
      );
      const foreign = f.path.join(root, "another-thread-attachment.png");
      yield* f.fs.writeFileString(foreign, "private other thread bytes");
      yield* f.fs.writeFileString(
        f.rolloutPath,
        original +
          json({ type: "event_msg", payload: { type: "view_image_tool_call", path: foreign } }) +
          "\n",
      );
      expect(yield* Effect.flip(f.archive.exportFrozen(f.input))).toMatchObject({
        message: expect.stringContaining("permitted storage"),
      });
      expect(yield* f.fs.exists(foreign)).toBe(true);
    }),
  );
  it.effect("rebuilds a frozen archive from bounded, verified chunks", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const saved = yield* f.archive.exportFrozen(f.input);
      const packed = yield* packThreadTransferArchive({
        archiveDirectory: saved.directory,
        scratchRoot: f.path.join(f.root, "chunk-storage"),
        expectedManifestSha256: saved.sha256,
        chunkSizeBytes: 1024,
      });
      expect(packed.manifest.files.some((file) => file.chunks.length > 1)).toBe(true);
      const repeated = yield* packThreadTransferArchive({
        archiveDirectory: saved.directory,
        scratchRoot: f.path.join(f.root, "chunk-storage"),
        expectedManifestSha256: saved.sha256,
        chunkSizeBytes: 1024,
      });
      expect(repeated.manifest).toEqual(packed.manifest);
      expect(repeated.sha256).toBe(packed.sha256);
      expect(repeated.artifactId).toBe(packed.artifactId);
      expect(repeated.uploads).toEqual(
        packed.uploads.map((upload) => ({
          ...upload,
          path: upload.path.replace(packed.directory, repeated.directory),
        })),
      );
      expect(packed.uploads.at(-1)).toMatchObject({
        artifactId: packed.artifactId,
        kind: "manifest",
        sha256: packed.sha256,
      });
      for (const upload of packed.uploads) {
        const bytes = yield* f.fs.readFile(upload.path);
        expect(bytes.byteLength).toBe(upload.sizeBytes);
        expect(NodeCrypto.createHash("sha256").update(bytes).digest("hex")).toBe(upload.sha256);
      }
      const restoredManifest = decodeChunks(
        yield* f.fs.readFileString(f.path.join(packed.directory, "chunks.json")),
      );
      expect(packed.sha256).toMatch(/^[0-9a-f]{64}$/u);
      const rebuilt = yield* materializeThreadTransferChunks({
        manifest: restoredManifest,
        chunkDirectory: packed.directory,
        destinationRoot: f.path.join(f.root, "rebuilt"),
        threadId: f.owner.threadId,
        operationId: f.owner.operationId,
        transferManifestSha256: saved.sha256,
      });
      const staged = yield* stageThreadTransferArchive({
        ...f.request(saved),
        artifactDirectory: rebuilt,
      });
      expect((yield* Stream.runCollect(staged.history.events)).length).toBe(2);
      expect(staged.native?.resumeCursor.threadId).toBe(nativeId);
      const first = packed.manifest.files.flatMap((file) => file.chunks)[0]!;
      yield* f.fs.writeFileString(f.path.join(packed.directory, first.artifactId), "changed");
      const error = yield* Effect.flip(
        materializeThreadTransferChunks({
          manifest: packed.manifest,
          chunkDirectory: packed.directory,
          destinationRoot: f.path.join(f.root, "corrupt-rebuild"),
          threadId: f.owner.threadId,
          operationId: f.owner.operationId,
          transferManifestSha256: saved.sha256,
        }),
      );
      expect(error._tag).toBe("ThreadTransferChunkError");
      expect(yield* f.fs.readDirectory(f.path.join(f.root, "corrupt-rebuild"))).toEqual([]);
      const unsafe = yield* Effect.flip(
        materializeThreadTransferChunks({
          manifest: {
            ...packed.manifest,
            files: [
              ...packed.manifest.files,
              {
                path: "../escape",
                sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                sizeBytes: 0,
                chunks: [],
              },
            ],
          },
          chunkDirectory: packed.directory,
          destinationRoot: f.path.join(f.root, "unsafe-rebuild"),
          threadId: f.owner.threadId,
          operationId: f.owner.operationId,
          transferManifestSha256: saved.sha256,
        }),
      );
      expect(unsafe._tag).toBe("ThreadTransferChunkError");
      expect(yield* f.fs.exists(f.path.join(f.root, "unsafe-rebuild"))).toBe(false);
    }),
  );
  it.effect("refuses a chunk destination aliased into the source archive", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const saved = yield* f.archive.exportFrozen(f.input);
      const alias = f.path.join(f.root, "archive-alias");
      yield* f.fs.symlink(saved.directory, alias);
      const error = yield* Effect.flip(
        packThreadTransferArchive({
          archiveDirectory: saved.directory,
          scratchRoot: alias,
          expectedManifestSha256: saved.sha256,
        }),
      );
      expect(error._tag).toBe("ThreadTransferChunkError");
      expect(yield* f.fs.readDirectory(saved.directory)).toContain("manifest.json");
    }),
  );
  it.effect(
    "stages the complete source after its workspace, attachments and provider home are gone",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const saved = yield* f.archive.exportFrozen(f.input);
        for (const directory of [f.workspace, f.attachmentsDir, f.codexHome])
          yield* f.fs.remove(directory, { recursive: true });
        const staged = yield* stageThreadTransferArchive(f.request(saved));
        expect(
          yield* f.fs.readFileString(f.path.join(staged.workspace.workspaceRoot, "README")),
        ).toBe("workspace bytes\n");
        expect((yield* f.fs.readDirectory(staged.attachments.attachmentsDir)).length).toBe(1);
        expect((yield* Stream.runCollect(staged.history.events)).length).toBe(2);
        expect(staged.native?.resumeCursor).toEqual({
          threadId: nativeId,
          resumePolicy: "require-existing",
        });
        expect(yield* f.fs.exists(f.path.join(staged.native!.homePath, "auth.json"))).toBe(false);
        expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("frozen");
      }),
  );
  it.effect("cleans every staged component when the final native import is corrupt", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const saved = yield* f.archive.exportFrozen(f.input);
      yield* f.fs.writeFileString(
        f.path.join(saved.directory, "native/rollout.jsonl"),
        "corrupt\n",
      );
      yield* Effect.flip(stageThreadTransferArchive(f.request(saved)));
      expect(yield* f.fs.readDirectory(f.request(saved).destinationRoot)).toEqual([]);
      expect(yield* f.fs.exists(f.rolloutPath)).toBe(true);
      expect(yield* f.fs.exists(f.workspace)).toBe(true);
    }),
  );
  it.effect("rejects a changed top-level manifest before staging any bytes", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const saved = yield* f.archive.exportFrozen(f.input);
      yield* f.fs.writeFileString(f.path.join(saved.directory, "manifest.json"), "{}\n");
      yield* Effect.flip(stageThreadTransferArchive(f.request(saved)));
      expect(yield* f.fs.exists(f.request(saved).destinationRoot)).toBe(false);
    }),
  );
  it.effect("does not export a provider that is still running", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sessions.upsert({ ...f.runtime, status: "running" });
      yield* Effect.flip(f.archive.exportFrozen(f.input));
      expect(yield* f.fs.exists(f.input.artifactRoot)).toBe(false);
    }),
  );
  it.effect("supports a queued thread that has never started a provider", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sessions.deleteByThreadId({ threadId: f.owner.threadId });
      const saved = yield* f.archive.exportFrozen({ ...f.input, native: null });
      expect(saved.manifest.native).toBe(null);
      const staged = yield* stageThreadTransferArchive(f.request(saved));
      expect(staged.native).toBe(null);
    }),
  );
  it.effect(
    "holds the source when an attachment is missing, without retaining partial components",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.fs.remove(f.attachmentsDir, { recursive: true });
        yield* Effect.flip(f.archive.exportFrozen(f.input));
        expect(yield* f.fs.readDirectory(f.input.artifactRoot)).toEqual([]);
        expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("frozen");
        expect(yield* f.fs.exists(f.rolloutPath)).toBe(true);
      }),
  );
  it.effect(
    "does not publish an archive when a rejected command receipt arrives during file export",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const intercept: ProcessRunner["Service"] = {
          run: (input) =>
            f.runner.run(input).pipe(
              Effect.tap(() =>
                input.args.includes("bundle") && input.args.includes("create")
                  ? f.sql`INSERT INTO orchestration_command_receipts
        (command_id, aggregate_kind, aggregate_id, project_id, accepted_at, result_sequence, status, error)
        VALUES (${"late-" + f.owner.threadId}, 'thread', ${f.owner.threadId}, NULL, ${at}, 0, 'rejected', 'Source frozen')`.pipe(
                      Effect.orDie,
                      Effect.asVoid,
                    )
                  : Effect.void,
              ),
            ),
        };
        const error = yield* Effect.flip(
          f.archive.exportFrozen(f.input).pipe(Effect.provideService(ProcessRunner, intercept)),
        );
        expect(error._tag).toBe("ThreadHistoryArchiveError");
        expect(yield* f.fs.readDirectory(f.input.artifactRoot)).toEqual([]);
        expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("frozen");
      }),
  );
  it.effect(
    "cleans the combined staging directory if interrupted after earlier components were copied",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const saved = yield* f.archive.exportFrozen(f.input);
        const entered = yield* Deferred.make<void>();
        const intercept: ProcessRunner["Service"] = {
          run: (input) =>
            input.args.includes("fetch")
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
              : f.runner.run(input),
        };
        const fiber = yield* stageThreadTransferArchive(f.request(saved)).pipe(
          Effect.provideService(ProcessRunner, intercept),
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        expect(yield* f.fs.readDirectory(f.request(saved).destinationRoot)).toEqual([]);
        expect(yield* f.fs.exists(f.path.join(saved.directory, "manifest.json"))).toBe(true);
      }),
  );
  it.effect("blocks copying nonstandard server state embedded inside a checkout", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const state = f.path.join(f.workspace, "custom-server-state");
      yield* f.fs.makeDirectory(state);
      yield* f.fs.writeFileString(f.path.join(state, "other-thread.sqlite"), "unrelated state");
      const error = yield* Effect.flip(
        f.archive.exportFrozen({ ...f.input, serverDataRoot: state }),
      );
      expect(error._tag).toBe("ThreadTransferArchiveError");
      expect(yield* f.fs.exists(f.input.artifactRoot)).toBe(false);
      expect(yield* f.fs.readFileString(f.path.join(state, "other-thread.sqlite"))).toBe(
        "unrelated state",
      );
    }),
  );
});
