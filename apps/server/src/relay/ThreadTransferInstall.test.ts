import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import {
  ProviderSessionRuntimeRepository,
  layer as SessionLayer,
} from "../persistence/ProviderSessionRuntime.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { ProcessRunner, layer as RunnerLayer } from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { makeThreadTransferArchive } from "./ThreadTransferArchive.ts";
import { stageThreadTransferArchive } from "./ThreadTransferArchive.ts";
import { makeThreadCheckoutInstaller } from "./ThreadCheckoutInstall.ts";
import { makeThreadTransferAborts } from "./ThreadTransferAbort.ts";
import { installThreadTransferArchive } from "./ThreadTransferInstall.ts";
import { resolvePortableCodexHome } from "../provider/Drivers/PortableCodexHome.ts";

const at = "2026-10-05T10:00:00.000Z";
const threadId = ThreadId.make("install-thread");
const instanceId = ProviderInstanceId.make("codex");
const nativeId = "00000000-0000-4000-8000-000000000001";
const encode = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const environment = (root: string) =>
  Layer.mergeAll(OrchestrationLayerLive, SessionLayer).pipe(
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), root)),
    Layer.provideMerge(RunnerLayer),
    Layer.provideMerge(NodeServices.layer),
  );
it.layer(Layer.merge(NodeServices.layer, RunnerLayer.pipe(Layer.provide(NodeServices.layer))))(
  "thread transfer installation",
  (it) => {
    for (const mode of ["main", "worktree", "fresh"] as const) {
      const dirty = mode === "worktree",
        fresh = mode === "fresh";
      it.effect(
        `installs a complete archive into a ${fresh ? "fresh VM main checkout" : dirty ? "worktree" : "clean main checkout"} and leaves execution frozen`,
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem,
                path = yield* Path.Path,
                runner = yield* ProcessRunner;
              const root = yield* fs.realPath(
                yield* fs.makeTempDirectoryScoped({ prefix: "complete-transfer-install-" }),
              );
              const sourceRoot = path.join(root, "source"),
                destinationRoot = path.join(root, "destination");
              const git = (cwd: string, args: ReadonlyArray<string>) =>
                runner
                  .run({
                    command: "git",
                    args: ["-c", "core.hooksPath=/dev/null", ...args],
                    cwd,
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
              yield* fs.makeDirectory(sourceRoot);
              yield* git(sourceRoot, ["init", "-b", "main"]);
              yield* fs.writeFileString(path.join(sourceRoot, "README"), "base\n");
              yield* git(sourceRoot, ["add", "."]);
              yield* git(sourceRoot, ["commit", "-m", "base"]);
              if (fresh) yield* fs.makeDirectory(destinationRoot);
              else yield* git(root, ["clone", "--no-local", sourceRoot, destinationRoot]);
              yield* fs.writeFileString(path.join(sourceRoot, "README"), "staged work\n");
              yield* git(sourceRoot, ["add", "README"]);
              yield* fs.writeFileString(path.join(sourceRoot, "README"), "unstaged work\n");
              if (dirty)
                yield* fs.writeFileString(path.join(destinationRoot, "local-note"), "preserve me");
              const sourceState = path.join(root, "source-state");
              const codexHome = path.join(sourceState, "codex");
              yield* fs.makeDirectory(path.join(codexHome, "sessions"), { recursive: true });
              const rolloutPath = path.join(
                codexHome,
                "sessions",
                `rollout-2026-10-05T10-00-00-${nativeId}.jsonl`,
              );
              yield* fs.writeFileString(
                rolloutPath,
                encode({
                  type: "session_meta",
                  payload: { id: nativeId, cli_version: "0.159.3", history_mode: "paginated" },
                }) + "\n",
              );
              yield* fs.writeFileString(
                path.join(codexHome, "auth.json"),
                "source credentials must stay here",
              );
              const source = {
                threadId,
                environmentId: "source",
                generation: 1,
                operationId: "move",
              };
              const { saved, retrySaved } = yield* Effect.gen(function* () {
                const engine = yield* OrchestrationEngineService;
                const projectId = ProjectId.make("source-project");
                yield* engine.dispatch({
                  type: "project.create",
                  commandId: CommandId.make("source-project"),
                  projectId,
                  title: "Source",
                  workspaceRoot: sourceRoot,
                  createdAt: at,
                });
                yield* engine.dispatch({
                  type: "thread.create",
                  commandId: CommandId.make("source-thread"),
                  threadId,
                  projectId,
                  title: "Move this",
                  modelSelection: { instanceId, model: "gpt-5" },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: "main",
                  worktreePath: null,
                  createdAt: at,
                });
                yield* (yield* ProviderSessionRuntimeRepository).upsert({
                  threadId,
                  providerName: "codex",
                  providerInstanceId: instanceId,
                  adapterKey: "codex",
                  runtimeMode: "full-access",
                  status: "stopped",
                  lastSeenAt: at,
                  resumeCursor: { threadId: nativeId },
                  runtimePayload: null,
                });
                const sql = yield* SqlClient.SqlClient,
                  fences = makeThreadExecutionFence(sql);
                const enrollment = {
                  ...source,
                  projectId,
                  relayUrl: "https://relay.example",
                  operationId: "enroll",
                };
                yield* fences.prepare(enrollment);
                yield* fences.activate(enrollment);
                yield* fences.beginDrain({ ...source, previousOperationId: "enroll" });
                yield* fences.freeze(source);
                const archive = makeThreadTransferArchive(sql, yield* OrchestrationEventStore);
                const exportInput = {
                  ...source,
                  artifactRoot: path.join(root, "artifacts"),
                  attachmentsDir: path.join(sourceState, "attachments"),
                  serverDataRoot: sourceState,
                  native: { codexHome, rolloutPath },
                };
                const saved = yield* archive.exportFrozen(exportInput);
                // A cancelled source reopens only its unchanged generation and
                // takes a fresh immutable archive for a new operation.
                yield* fences.activate(source);
                const retry = { ...source, operationId: "retry" };
                yield* fences.beginDrain({ ...retry, previousOperationId: source.operationId });
                yield* fences.freeze(retry);
                const retrySaved = yield* archive.exportFrozen({ ...exportInput, ...retry });
                return { saved, retrySaved };
              }).pipe(Effect.provide(environment(sourceState)));
              yield* fs.remove(sourceRoot, { recursive: true });
              yield* fs.remove(sourceState, { recursive: true });
              yield* Effect.gen(function* () {
                const engine = yield* OrchestrationEngineService,
                  sql = yield* SqlClient.SqlClient;
                const projectId = ProjectId.make("destination-project"),
                  fences = makeThreadExecutionFence(sql);
                const destination = {
                  projectId,
                  environmentId: "destination",
                  relayUrl: "https://relay.example",
                  generation: 2,
                };
                yield* engine.dispatch({
                  type: "project.create",
                  commandId: CommandId.make("destination-project"),
                  projectId,
                  title: "Destination",
                  workspaceRoot: destinationRoot,
                  createdAt: at,
                });
                yield* fences.prepare({
                  ...destination,
                  threadId,
                  operationId: source.operationId,
                });
                const input = {
                  source,
                  destination,
                  manifestSha256: saved.sha256,
                  artifactDirectory: saved.directory,
                  recoveryRoot: path.join(root, "recovery"),
                  worktreesRoot: path.join(root, "worktrees"),
                  stateDir: path.join(root, "destination-state"),
                  attachmentsDir: path.join(root, "destination-attachments"),
                  providerInstanceId: instanceId,
                  codexVersion: "0.159.3",
                  importedAt: at,
                  ...(fresh ? { freshCheckoutRoot: destinationRoot } : {}),
                };
                const installed = yield* installThreadTransferArchive(input);
                expect(yield* installThreadTransferArchive(input)).toEqual(installed);
                expect(yield* fs.readFileString(path.join(installed.checkoutPath, "README"))).toBe(
                  "unstaged work\n",
                );
                expect((yield* git(installed.checkoutPath, ["show", ":README"])).stdout).toBe(
                  "staged work\n",
                );
                expect(installed.checkoutPath === destinationRoot).toBe(!dirty);
                if (dirty)
                  expect(yield* fs.readFileString(path.join(destinationRoot, "local-note"))).toBe(
                    "preserve me",
                  );
                const runtime = Option.getOrThrow(
                  yield* (yield* ProviderSessionRuntimeRepository).getByThreadId({ threadId }),
                );
                expect(runtime.status).toBe("stopped");
                expect(runtime.resumeCursor).toEqual({
                  threadId: nativeId,
                  resumePolicy: "require-existing",
                  portableStateId: installed.portableStateId,
                });
                const native = yield* resolvePortableCodexHome({
                  stateDir: input.stateDir,
                  threadId,
                  providerInstanceId: instanceId,
                  nativeThreadId: nativeId,
                  portableStateId: installed.portableStateId!,
                });
                expect(yield* fs.exists(path.join(native.homePath, "auth.json"))).toBe(false);
                const snapshot = yield* (yield* ProjectionSnapshotQuery).getSnapshot();
                expect(snapshot.threads[0]?.projectId).toBe(projectId);
                expect((yield* fences.get(threadId))?.phase).toBe("frozen");
                yield* Effect.flip(
                  engine.dispatch({
                    type: "thread.meta.update",
                    commandId: CommandId.make("not-active"),
                    threadId,
                    title: "too soon",
                  }),
                );
                if (fresh) {
                  expect(snapshot.threads[0]?.worktreePath).toBeNull();
                  expect(
                    (yield* sql<{
                      fresh: number;
                    }>`SELECT fresh_checkout AS fresh FROM thread_checkout_claims WHERE operation_id='move'`)[0]
                      ?.fresh,
                  ).toBe(1);
                  // An interrupted acknowledgement reconciles the installed bytes,
                  // without treating this main checkout as a new local repository.
                  yield* sql`UPDATE thread_checkout_claims SET phase='installing' WHERE operation_id='move'`;
                  yield* makeThreadCheckoutInstaller(sql).reconcile({
                    ...source,
                    generation: 2,
                    projectId,
                    manifestSha256: saved.sha256,
                    workspace: saved.manifest.workspace,
                    stagedWorkspaceRoot: destinationRoot,
                    worktreesRoot: input.worktreesRoot,
                  });
                  expect(yield* installThreadTransferArchive(input)).toEqual(installed);
                  return;
                }
                const staged = yield* stageThreadTransferArchive({
                  owner: source,
                  expectedSha256: saved.sha256,
                  artifactDirectory: saved.directory,
                  destinationRoot: path.join(root, "rollback-stage"),
                  codexVersion: input.codexVersion,
                });
                yield* makeThreadCheckoutInstaller(sql).rollback({
                  ...source,
                  generation: 2,
                  projectId,
                  manifestSha256: saved.sha256,
                  workspace: saved.manifest.workspace,
                  stagedWorkspaceRoot: staged.workspace.workspaceRoot,
                  worktreesRoot: input.worktreesRoot,
                  recoveryRoot: input.recoveryRoot,
                });
                expect(yield* fs.readFileString(path.join(destinationRoot, "README"))).toBe(
                  "base\n",
                );
                const aborted = {
                  threadId,
                  operationId: source.operationId,
                  sourceEnvironmentId: EnvironmentId.make("source"),
                  destinationEnvironmentId: EnvironmentId.make("destination"),
                  destinationProjectId: projectId,
                  actorUserId: "owner",
                  expectedGeneration: 1,
                  phase: "aborted" as const,
                  sourceCursor: saved.manifest.history.sourceSequence,
                  manifestSha256: saved.sha256,
                  manifestArtifactId: null,
                };
                yield* makeThreadTransferAborts(sql).record(
                  { ...destination, threadId, operationId: source.operationId },
                  aborted,
                );
                expect((yield* fences.get(threadId))?.phase).toBe("retired");
                yield* Effect.flip(
                  fences.activate({ ...destination, threadId, operationId: source.operationId }),
                );
                const retry = { ...source, operationId: "retry" };
                yield* fences.prepare({ ...destination, threadId, operationId: retry.operationId });
                expect((yield* fences.get(threadId))?.operationId).toBe("retry");
                expect(
                  yield* sql`SELECT 1 FROM thread_transfer_baselines WHERE operation_id='move'`,
                ).toEqual([]);
                expect(
                  yield* sql`SELECT 1 FROM thread_checkout_claims WHERE operation_id='move'`,
                ).toEqual([]);
                const inherited = yield* makeThreadTransferAborts(sql).eventIds(threadId);
                expect(inherited.has("thread-transfer:move")).toBe(true);
                const reinstalled = yield* installThreadTransferArchive({
                  ...input,
                  source: retry,
                  manifestSha256: retrySaved.sha256,
                  artifactDirectory: retrySaved.directory,
                });
                expect(
                  yield* fs.readFileString(path.join(reinstalled.checkoutPath, "README")),
                ).toBe("unstaged work\n");
              }).pipe(Effect.provide(environment(path.join(root, "destination-server"))));
            }),
          ),
      );
    }
  },
);
