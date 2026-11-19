// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CheckpointRef,
  EnvironmentId,
  ProjectId,
  ThreadId,
  TurnId,
  type VcsError,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { checkpointRefForThreadTurn } from "./Utils.ts";
import { parseTurnDiffFilesFromNumstat } from "./Diffs.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import { WorkflowRun, WorkflowRunStore } from "../jobs/WorkflowRunStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { THREAD_VM_IDENTITY_SECRET } from "../relay/ThreadVmEnrollment.ts";
import {
  workflowVmCancellationOperation,
  workflowVmCancellationSeal,
} from "../relay/WorkflowVmCancellation.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkflowVmAttempts } from "../relay/WorkflowVmAttempts.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  WORKFLOW_REVIEW_SOURCE_REF,
  WorkflowReviewGitDirectory,
} from "../vcs/WorkflowReviewGitDirectory.ts";
import { VmWorkloadTracking, WorkflowVmGuest, withVmWorkloads } from "../vmWorkloadCommand.ts";
import { inspectVmWorkloads } from "../vmWorkload.ts";
import * as ServerConfig from "../config.ts";

const ServerConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-checkpoint-store-test-",
});
const VcsProcessTestLayer = VcsProcess.layerLocal.pipe(Layer.provide(NodeServices.layer));
const VcsDriverTestLayer = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessTestLayer));
const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(NodeServices.layer),
);
const TestLayer = CheckpointStoreTestLayer.pipe(
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);
const encodeFixtureJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeFixtureRun = Schema.decodeEffect(WorkflowRun);
const decodeFixtureRunJson = Schema.decodeEffect(Schema.fromJsonString(WorkflowRun));
const decodeFixtureJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

function makeTmpDir(
  prefix = "checkpoint-store-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "CheckpointStore.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
}

function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  VcsError | PlatformError.PlatformError,
  VcsProcess.VcsProcess | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* git(cwd, ["init"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* git(cwd, ["config", "commit.gpgsign", "false"]);
    yield* writeTextFile(NodePath.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

function buildLargeText(lineCount = 5_000): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, "0")}`)
    .join("\n")
    .concat("\n");
}

it.layer(TestLayer)("CheckpointStore.layer", (it) => {
  it.effect(
    "reads real pinned diffs after cancellation through a preconstructed and restarted VM stack",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(yield* makeTmpDir());
        const cwd = NodePath.join(root, "worktree");
        const directory = NodePath.join(root, "private-review.git");
        yield* fs.makeDirectory(cwd);
        yield* initRepoWithCommit(cwd);
        yield* git(root, ["init", "--bare", directory]);
        yield* git(directory, [
          "fetch",
          "--no-tags",
          `file://${cwd}`,
          `HEAD:${WORKFLOW_REVIEW_SOURCE_REF}`,
        ]);
        const threadId = ThreadId.make("workflow:cancelled-diff");
        const projectId = ProjectId.make("vm:cancelled-diff");
        const turnId = TurnId.make("cancelled-turn");
        const binding = {
          kind: "vm" as const,
          jobId: "cancelled-diff",
          organizationId: "org",
          repositoryId: "repo",
          threadId,
          allocationId: "allocation",
          environmentId: EnvironmentId.make("environment"),
          generation: 1,
          operationId: "enroll",
          projectId,
        };
        const proof = {
          ...binding,
          cancellationId: "cancel",
          runtimeEpisode: "episode",
          continuationKey: "codex:instance:codex",
          providerInstanceId: "codex",
          bootId: "cb7c9212-2128-478f-9d11-6e4c8ed6f882",
          epoch: 1,
        };
        const run = yield* decodeFixtureRun({
          jobId: binding.jobId,
          userId: "owner",
          repositoryCanonicalKey: "github.com/acme/repo",
          instruction: "Work",
          modelSelection: { instanceId: "codex", model: "gpt-test" },
          providerContinuation: { driver: "codex", continuationKey: proof.continuationKey },
          baseBranch: "main",
          baseSha: "base",
          createdAt: "2026-11-06T00:00:00.000Z",
          promptDispatched: true,
          executionReserved: false,
          worktreePath: cwd,
          preparedHead: null,
          approvedBy: null,
          cancellationAttempt: null,
          runtime: binding,
          workflow: {
            workflowId: "workflow",
            organizationId: "org",
            repositoryId: "repo",
            revision: 1,
            archived: false,
            createdAt: "2026-11-06T00:00:00.000Z",
            updatedAt: "2026-11-06T00:00:00.000Z",
            definition: {
              name: "Workflow",
              target: { kind: "vm", baseBranch: null },
              steps: [
                {
                  id: "agent",
                  kind: "agent",
                  title: "Work",
                  instruction: "Work",
                  modelSelection: null,
                },
              ],
            },
          },
          progress: { revision: 3, status: "cancelled", threadId, detail: null, checkpoint: null },
        });
        const sql = yield* SqlClient.SqlClient;
        const json = encodeFixtureJson;
        const running = {
          ...run,
          executionReserved: true,
          progress: { ...run.progress, status: "running" },
        };
        yield* sql`INSERT INTO repository_workflow_jobs(job_id,thread_id,status,execution_reserved,record_json) VALUES(${binding.jobId},${threadId},'running',1,${json(running)})`;
        yield* sql`INSERT INTO thread_execution_fences(thread_id,relay_url,environment_id,project_id,generation,operation_id,phase) VALUES(${threadId},'https://relay.test',${binding.environmentId},${projectId},1,'enroll','active')`;
        const installed = {
          operationId: binding.operationId,
          scope: {
            allocationId: binding.allocationId,
            threadId,
            repositoryId: binding.repositoryId,
            generation: 1,
          },
          relayUrl: "https://relay.test",
          relayIssuer: "https://relay.test",
          environmentId: binding.environmentId,
          environmentCredential: "test-only",
          cloudMintPublicKey: "test-only",
        };
        const secretLayer = Layer.mock(ServerSecretStore)({
          get: (key) =>
            Effect.succeed(
              key === THREAD_VM_IDENTITY_SECRET
                ? Option.some(new TextEncoder().encode(json(installed)))
                : Option.none(),
            ),
        });
        const native = yield* ChildProcessSpawner.ChildProcessSpawner;
        const reader = NodeURL.fileURLToPath(
          new URL("../../../../infra/e2b/template/workflow-checkpoint-reader.py", import.meta.url),
        );
        const kernel = { sealed: false, transferLaunches: 0, rejectedLaunches: 0 };
        const report = () => ({
          bootId: proof.bootId,
          epoch: kernel.sealed ? proof.epoch : 0,
          sealedBy: kernel.sealed ? workflowVmCancellationSeal(proof) : null,
          groups: [],
          stopped: true,
        });
        const spawner = ChildProcessSpawner.make((command) => {
          if (
            !ChildProcess.isStandardCommand(command) ||
            command.command !== "/opt/launchpad/bin/launchpad-workload"
          )
            return native.spawn(command);
          const action = command.args[0];
          if (action === "seal" || action === "stop") {
            expect(command.args.slice(1)).toEqual([
              proof.bootId,
              workflowVmCancellationSeal(proof),
            ]);
            if (action === "stop") expect(kernel.sealed).toBe(true);
            kernel.sealed = true;
          }
          if (action === "inspect" || action === "seal" || action === "stop")
            return Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                unref: Effect.succeed(Effect.void),
                stdin: Sink.drain,
                stdout: Stream.encodeText(Stream.make(json(report()))),
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              }),
            );
          if (kernel.sealed) {
            if (action !== "run-transfer") {
              kernel.rejectedLaunches++;
              return Effect.fail(
                PlatformError.badArgument({
                  module: "VmWorkload",
                  method: "spawn",
                  description: "Workload launches are sealed",
                }),
              );
            }
            expect(command.args.slice(1, 4)).toEqual([
              proof.bootId,
              workflowVmCancellationSeal(proof),
              String(proof.epoch),
            ]);
            kernel.transferLaunches++;
          }
          const separator = command.args.indexOf("--");
          const executable = command.args[separator + 1]!;
          const args = command.args.slice(separator + 2);
          const launchCwd = action === "run-workflow" ? command.args[3] : command.options.cwd;
          return native.spawn(
            ChildProcess.make(
              executable,
              executable === "/usr/bin/python3" ? ["-IS", reader, args[2]!] : args,
              {
                ...command.options,
                cwd: launchCwd,
                env: {
                  ...command.options.env,
                  HOME: process.env.HOME,
                  USER: process.env.USER,
                  LOGNAME: process.env.LOGNAME,
                  PATH: process.env.PATH,
                },
              },
            ),
          );
        });
        const from = checkpointRefForThreadTurn(threadId, 0),
          to = checkpointRefForThreadTurn(threadId, 1);
        const store = yield* withVmWorkloads(
          CheckpointStore.make.pipe(
            Effect.provide(
              Layer.fresh(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layerLocal))),
            ),
          ),
          true,
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        const captures = yield* withVmWorkloads(
          Effect.gen(function* () {
            const baseline = yield* store.captureCheckpoint({
              cwd,
              checkpointRef: from,
              strictWorkflowCapture: true,
            });
            yield* writeTextFile(
              NodePath.join(cwd, "README.md"),
              "# test\nSaved before cancellation\n",
            );
            const checkpoint = yield* store.captureCheckpoint({
              cwd,
              checkpointRef: to,
              strictWorkflowCapture: true,
            });
            return { baseline, checkpoint };
          }),
          true,
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(WorkflowReviewGitDirectory, directory),
        );
        const runs = yield* WorkflowRunStore,
          attempts = yield* WorkflowVmAttempts;
        const projection = Layer.mock(ProjectionSnapshotQuery)({
          getThreadCheckpointContext: () =>
            Effect.succeedSome({
              threadId,
              projectId,
              workspaceRoot: cwd,
              worktreePath: null,
              checkpoints: [
                {
                  turnId,
                  checkpointTurnCount: 1,
                  checkpointRef: to,
                  status: "ready",
                  files: [],
                  assistantMessageId: null,
                  completedAt: run.createdAt,
                },
              ],
            }),
          getFullThreadDiffContext: () =>
            Effect.succeedSome({
              threadId,
              projectId,
              workspaceRoot: cwd,
              worktreePath: null,
              latestCheckpointTurnCount: 1,
              toCheckpointRef: to,
            }),
        });
        const queryEffect = CheckpointDiffQuery.make.pipe(
          Effect.provide(projection),
          Effect.provideService(CheckpointStore.CheckpointStore, store),
          Effect.provideService(WorkflowRunStore, {
            ...runs,
            getVmBindingForThread: () => Effect.succeed(binding),
            getCheckpointPinForRun: () =>
              Effect.succeed({
                ...captures.baseline,
                baselineCommitId: captures.baseline.commitId,
                checkpointRef: from,
              }),
            getCheckpointPinForTurn: () =>
              Effect.succeed({
                ...captures.checkpoint,
                baselineCommitId: captures.baseline.commitId,
                checkpointRef: to,
              }),
          }),
          Effect.provideService(WorkflowVmAttempts, {
            ...attempts,
            readReviewSecrets: () => Effect.succeed(Redacted.make([])),
          }),
        );
        const query = yield* withVmWorkloads(queryEffect, true).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        yield* withVmWorkloads(
          Effect.gen(function* () {
            yield* inspectVmWorkloads({
              type: "seal",
              bootId: proof.bootId,
              operationId: workflowVmCancellationOperation(proof),
            });
            yield* inspectVmWorkloads({
              type: "stop",
              bootId: proof.bootId,
              operationId: workflowVmCancellationOperation(proof),
            });
          }),
          true,
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        yield* sql`UPDATE repository_workflow_jobs SET status='cancelled',execution_reserved=0,record_json=${json(run)} WHERE job_id=${binding.jobId}`;
        const payload = {
          workflowVmCancellation: proof,
          stoppedRuntimeEventsDrained: true,
          providerContinuation: {
            workflowJobId: binding.jobId,
            continuationKey: proof.continuationKey,
            runtimeEpisode: proof.runtimeEpisode,
            shutdownConfirmed: true,
            shutdownEvidenceVersion: 2,
          },
        };
        yield* sql`INSERT INTO provider_session_runtime(thread_id,provider_name,provider_instance_id,adapter_key,status,last_seen_at,runtime_payload_json) VALUES(${threadId},'codex','codex','codex','stopped',${run.createdAt},${json(payload)})`;
        const strict = {
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          strictWorkflowReview: true,
          expectedTurnId: turnId,
        };
        for (const restart of [false, true])
          yield* withVmWorkloads(
            Effect.gen(function* () {
              const current = restart ? yield* queryEffect : query;
              const turn = yield* current.getTurnDiff(strict);
              expect(turn.completeWorkflowReview).toBe(true);
              expect(turn.diff).toContain("+Saved before cancellation");
              expect(
                (yield* current.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 })).diff,
              ).toBe(turn.diff);
              expect((yield* current.getFullThreadDiff({ threadId, toTurnCount: 1 })).diff).toBe(
                turn.diff,
              );
              expect(
                yield* Effect.flip(
                  store.captureCheckpoint({ cwd, checkpointRef: to, strictWorkflowCapture: true }),
                ),
              ).toBeDefined();
              expect(
                yield* Effect.flip(
                  store.deleteCheckpointRefs({ cwd, checkpointRefs: [to], pinned: true }),
                ),
              ).toBeDefined();
            }),
            true,
          ).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(WorkflowReviewGitDirectory, directory),
            Effect.provide(secretLayer),
          );
        expect(kernel.transferLaunches).toBeGreaterThan(0);
        expect(kernel.rejectedLaunches).toBeGreaterThanOrEqual(4);
        expect(report()).toEqual({
          bootId: proof.bootId,
          epoch: proof.epoch,
          sealedBy: workflowVmCancellationSeal(proof),
          groups: [],
          stopped: true,
        });
        const [retained] = yield* sql<{
          record: string;
          payload: string;
        }>`SELECT j.record_json AS record,p.runtime_payload_json AS payload FROM repository_workflow_jobs j JOIN provider_session_runtime p ON p.thread_id=j.thread_id WHERE j.job_id=${binding.jobId}`;
        const retainedRun = yield* decodeFixtureRunJson(retained!.record);
        const retainedPayload = yield* decodeFixtureJson(retained!.payload);
        expect(retainedRun.cancellationAttempt).toBeNull();
        expect(retainedPayload).toEqual(payload);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("checks the real pinned patch before returning review and finished result diffs", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const threadId = ThreadId.make("workflow:secret-patch");
      const projectId = ProjectId.make("vm:secret-patch");
      const turnId = TurnId.make("turn-1");
      const binding = {
        kind: "vm" as const,
        jobId: "secret-patch",
        organizationId: "org",
        repositoryId: "repo",
        threadId,
        allocationId: "allocation",
        environmentId: EnvironmentId.make("environment"),
        generation: 1,
        operationId: "operation",
        projectId,
      };
      const baselineRef = checkpointRefForThreadTurn(threadId, 0);
      const targetRef = checkpointRefForThreadTurn(threadId, 1);
      const store = yield* CheckpointStore.CheckpointStore;
      const baseline = yield* store.captureCheckpoint({
        cwd,
        checkpointRef: baselineRef,
        strictWorkflowCapture: true,
      });
      const secretLine = "fixture-token-only-in-git";
      yield* writeTextFile(NodePath.join(cwd, "README.md"), `# test\n${secretLine}\n`);
      const secretFilename = "clé-confidentielle";
      yield* git(cwd, ["config", "core.quotePath", "true"]);
      yield* writeTextFile(NodePath.join(cwd, secretFilename), "hidden file\n");
      const checkpoint = yield* store.captureCheckpoint({
        cwd,
        checkpointRef: targetRef,
        strictWorkflowCapture: true,
      });
      // Simulate a stale capture moving the ref and a replacement object in the checkout.
      yield* git(cwd, ["update-ref", baselineRef, checkpoint.commitId]);
      yield* git(cwd, ["replace", checkpoint.commitId, baseline.commitId]);
      const runs = yield* WorkflowRunStore;
      const attempts = yield* WorkflowVmAttempts;
      const context = { threadId, projectId, workspaceRoot: cwd, worktreePath: null };
      const projection = Layer.mock(ProjectionSnapshotQuery)({
        getThreadCheckpointContext: () =>
          Effect.succeedSome({
            ...context,
            checkpoints: [
              {
                turnId,
                checkpointTurnCount: 1,
                checkpointRef: targetRef,
                status: "ready",
                files: [],
                assistantMessageId: null,
                completedAt: "2026-11-04T00:00:00.000Z",
              },
            ],
          }),
        getFullThreadDiffContext: () =>
          Effect.succeedSome({
            ...context,
            latestCheckpointTurnCount: 1,
            toCheckpointRef: targetRef,
          }),
      });
      let secrets: ReadonlyArray<string> | null = [`first-secret-line\n${secretLine}`];
      const query = yield* CheckpointDiffQuery.make.pipe(
        Effect.provide(projection),
        Effect.provideService(WorkflowRunStore, {
          ...runs,
          getVmBindingForThread: () => Effect.succeed(binding),
          getCheckpointPinForRun: () =>
            Effect.succeed({
              ...baseline,
              baselineCommitId: baseline.commitId,
              checkpointRef: baselineRef,
            }),
          getCheckpointPinForTurn: () =>
            Effect.succeed({
              ...checkpoint,
              baselineCommitId: baseline.commitId,
              checkpointRef: targetRef,
            }),
        }),
        Effect.provideService(WorkflowVmAttempts, {
          ...attempts,
          readReviewSecrets: (requested) =>
            secrets === null
              ? attempts.readReviewSecrets(requested)
              : Effect.succeed(Redacted.make(secrets)),
        }),
      );
      const requests = [
        query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          strictWorkflowReview: true,
          expectedTurnId: turnId,
        }),
        query.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 }),
        query.getFullThreadDiff({ threadId, toTurnCount: 1 }),
      ];
      for (const request of requests) {
        const failure = yield* Effect.flip(request);
        expect(failure).toMatchObject({
          _tag: "CheckpointWorkflowDiffRestrictedError",
          reason: "contains_secret",
        });
        expect(failure.message).not.toContain(secretLine);
      }
      secrets = [secretFilename];
      expect(yield* Effect.flip(requests[2]!)).toMatchObject({ reason: "contains_secret" });
      secrets = null;
      expect(yield* Effect.flip(requests[2]!)).toMatchObject({
        reason: "verification_unavailable",
      });
      secrets = ["a", "a-different-token"];
      expect(yield* requests[0]!).toMatchObject({
        completeWorkflowReview: true,
        targetTurnId: turnId,
      });
      expect((yield* requests[1]!).diff).toContain(`+${secretLine}`);
      const finishedPatch = (yield* requests[2]!).diff;
      expect(finishedPatch).toContain(`+${secretLine}`);
      expect(finishedPatch).toContain("cl\\303\\251-confidentielle");
    }),
  );

  describe("workflow checkpoint capture", () => {
    it.effect.each(["self-ignored", "nested self-ignored", "ignored by local exclude"] as const)(
      "rejects an untracked ignore file missing from the checkpoint (%s)",
      (scenario) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const fs = yield* FileSystem.FileSystem;
          yield* initRepoWithCommit(cwd);
          const directory = scenario === "nested self-ignored" ? NodePath.join(cwd, "nested") : cwd;
          if (directory !== cwd) yield* fs.makeDirectory(directory);
          if (scenario === "ignored by local exclude")
            yield* writeTextFile(NodePath.join(cwd, ".git", "info", "exclude"), "/.gitignore\n");

          const checkpoints = yield* CheckpointStore.CheckpointStore;
          const baseline = yield* checkpoints.captureCheckpoint({
            cwd,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/ignore/initial"),
            strictWorkflowCapture: true,
          });
          yield* writeTextFile(
            NodePath.join(directory, ".gitignore"),
            scenario === "ignored by local exclude" ? "hidden.txt\n" : ".gitignore\nhidden.txt\n",
          );
          yield* writeTextFile(NodePath.join(directory, "hidden.txt"), "unreviewed change\n");
          const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/ignore/result");
          expect(
            yield* Effect.flip(
              checkpoints.captureCheckpoint({
                cwd,
                checkpointRef,
                strictWorkflowCapture: true,
                workflowIgnoreRules: baseline.workflowIgnoreRules!,
              }),
            ),
          ).toMatchObject({
            _tag: "VcsProcessExitError",
            detail: "The workflow Git checkpoint cannot verify an ignored .gitignore file.",
          });
          expect(yield* git(cwd, ["for-each-ref", checkpointRef])).toBe("");
        }),
    );

    it.effect("captures reviewable ignore rules and skips files inside ignored directories", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const fs = yield* FileSystem.FileSystem;
        yield* initRepoWithCommit(cwd);
        const rootRule = NodePath.join(cwd, ".gitignore");
        yield* writeTextFile(rootRule, "/cache/\n");
        yield* git(cwd, ["add", ".gitignore"]);
        yield* git(cwd, ["commit", "-m", "track root ignore rules"]);
        const changedRootRule = "/.gitignore\n/cache/\n/ignored.txt\n";
        yield* writeTextFile(rootRule, changedRootRule);
        yield* writeTextFile(NodePath.join(cwd, "ignored.txt"), "tracked rule exclusion\n");
        yield* fs.makeDirectory(NodePath.join(cwd, "src"));
        yield* writeTextFile(NodePath.join(cwd, "src", ".gitignore"), "temporary.txt\n");
        yield* writeTextFile(NodePath.join(cwd, "src", "temporary.txt"), "new rule exclusion\n");
        yield* writeTextFile(NodePath.join(cwd, "src", "result.txt"), "reviewable change\n");
        yield* fs.makeDirectory(NodePath.join(cwd, "cache"));
        yield* writeTextFile(NodePath.join(cwd, "cache", ".gitignore"), ".gitignore\n");

        const checkpoints = yield* CheckpointStore.CheckpointStore;
        const checkpoint = yield* checkpoints.captureCheckpoint({
          cwd,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/ignore/reviewable"),
          strictWorkflowCapture: true,
        });
        expect(yield* git(cwd, ["ls-tree", "-r", "--name-only", checkpoint.commitId])).toBe(
          ".gitignore\nREADME.md\nsrc/.gitignore\nsrc/result.txt",
        );
        expect(yield* git(cwd, ["show", `${checkpoint.commitId}:.gitignore`])).toBe(
          changedRootRule.trimEnd(),
        );
      }),
    );

    it.effect("freezes checkout-local ignores and does not use the ambient Git ignore file", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const configHome = yield* makeTmpDir();
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(NodePath.join(configHome, "git"));
        yield* writeTextFile(NodePath.join(configHome, "git", "ignore"), "ambient.txt\n");
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const previous = {
              XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
              GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
            };
            process.env.XDG_CONFIG_HOME = configHome;
            process.env.GIT_CONFIG_GLOBAL = "/dev/null";
            return previous;
          }),
          (previous) =>
            Effect.sync(() => {
              for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
              }
            }),
        );
        yield* initRepoWithCommit(cwd);
        const exclude = NodePath.join(cwd, ".git", "info", "exclude");
        const frozenRules = "setup-local.txt\nREADME.md\n";
        yield* writeTextFile(exclude, frozenRules);
        yield* writeTextFile(NodePath.join(cwd, "setup-local.txt"), "private fixture\n");
        const checkpoints = yield* CheckpointStore.CheckpointStore;
        const initial = yield* checkpoints.captureCheckpoint({
          cwd,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/ignore/initial"),
          strictWorkflowCapture: true,
        });
        expect(initial.workflowIgnoreRules).toEqual(new TextEncoder().encode(frozenRules));
        expect(yield* git(cwd, ["ls-tree", "-r", "--name-only", initial.commitId])).toBe(
          "README.md",
        );

        yield* writeTextFile(NodePath.join(cwd, "README.md"), "tracked workflow change\n");
        yield* writeTextFile(NodePath.join(cwd, "setup-local.txt"), "new private fixture\n");
        yield* writeTextFile(NodePath.join(cwd, "ambient.txt"), "new workflow file\n");
        expect(yield* git(cwd, ["status", "--short"])).toBe("M README.md");
        const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/ignore/result");
        const input = {
          cwd,
          checkpointRef,
          strictWorkflowCapture: true,
          workflowIgnoreRules: initial.workflowIgnoreRules!,
        };
        for (const changed of [frozenRules + "ambient.txt\n", "README.md\n"]) {
          yield* writeTextFile(exclude, changed);
          expect(yield* Effect.flip(checkpoints.captureCheckpoint(input))).toMatchObject({
            _tag: "VcsProcessExitError",
            detail: "The workflow Git ignore rules changed after preparation.",
          });
          expect(yield* git(cwd, ["for-each-ref", checkpointRef])).toBe("");
        }

        yield* writeTextFile(exclude, frozenRules);
        const result = yield* checkpoints.captureCheckpoint(input);
        expect(yield* git(cwd, ["ls-tree", "-r", "--name-only", result.commitId])).toBe(
          "README.md\nambient.txt",
        );
        const patch = yield* checkpoints.diffCheckpoints({
          cwd,
          fromCheckpointRef: CheckpointRef.make(initial.commitId),
          toCheckpointRef: CheckpointRef.make(result.commitId),
          ignoreWhitespace: false,
          requireComplete: true,
        });
        expect(patch).toContain("+tracked workflow change");
        expect(patch).toContain("+new workflow file");
        expect(patch).not.toContain("private fixture");
      }),
    );

    it.effect.each(["symlink", "ancestor-symlink", "oversized", "custom-exclude"] as const)(
      "rejects unsafe workflow ignore sources (%s)",
      (scenario) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const fs = yield* FileSystem.FileSystem;
          yield* initRepoWithCommit(cwd);
          const info = NodePath.join(cwd, ".git", "info");
          const exclude = NodePath.join(info, "exclude");
          const other = yield* makeTmpDir();
          const otherExclude = NodePath.join(other, "exclude");
          yield* writeTextFile(otherExclude, "hidden.txt\n");
          switch (scenario) {
            case "symlink":
              yield* fs.remove(exclude);
              yield* fs.symlink(otherExclude, exclude);
              break;
            case "ancestor-symlink":
              yield* fs.remove(info, { recursive: true });
              yield* fs.symlink(other, info);
              break;
            case "oversized":
              yield* writeTextFile(exclude, "x".repeat(64 * 1024 + 1));
              break;
            case "custom-exclude":
              yield* git(cwd, ["config", "core.excludesFile", otherExclude]);
              break;
          }
          const checkpoints = yield* CheckpointStore.CheckpointStore;
          const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/ignore/unsafe");
          expect(
            yield* Effect.flip(
              checkpoints.captureCheckpoint({ cwd, checkpointRef, strictWorkflowCapture: true }),
            ),
          ).toMatchObject({
            _tag: "VcsProcessExitError",
            detail:
              scenario === "custom-exclude"
                ? "The workflow Git checkpoint does not support custom exclude files."
                : "The workflow Git ignore rules are unavailable.",
          });
          expect(yield* git(cwd, ["for-each-ref", checkpointRef])).toBe("");
        }),
    );

    it.effect("writes and deletes a symbolic checkpoint without changing its target branch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const checkpoints = yield* CheckpointStore.CheckpointStore;
        const checkpointRef = CheckpointRef.make("refs/t3/workflow-verification/test");
        const branch = yield* git(cwd, ["symbolic-ref", "HEAD"]);
        const head = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* writeTextFile(NodePath.join(cwd, "README.md"), "approved contents\n");
        yield* git(cwd, ["symbolic-ref", checkpointRef, branch]);
        const snapshot = yield* checkpoints.captureCheckpoint({
          cwd,
          checkpointRef,
          strictWorkflowCapture: true,
        });
        expect(yield* git(cwd, ["rev-parse", checkpointRef])).toBe(snapshot.commitId);
        expect(yield* git(cwd, ["rev-parse", branch])).toBe(head);
        yield* git(cwd, ["symbolic-ref", checkpointRef, branch]);
        yield* checkpoints.deleteCheckpointRefs({ cwd, checkpointRefs: [checkpointRef] });
        expect(yield* checkpoints.hasCheckpointRef({ cwd, checkpointRef })).toBe(false);
        expect(yield* git(cwd, ["rev-parse", branch])).toBe(head);
      }),
    );

    it.effect("re-reads file contents even if the checkout index lies about their stat cache", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const fs = yield* FileSystem.FileSystem;
        yield* git(cwd, ["init", "--object-format=sha1"]);
        const filePath = NodePath.join(cwd, "README.md");
        yield* writeTextFile(filePath, "safe\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@test.com",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "initial",
        ]);
        yield* git(cwd, ["update-index", "--index-version=2"]);
        yield* writeTextFile(filePath, "evil\n");
        yield* fs.utimes(filePath, 1_700_000_000, 1_700_000_000);
        const stat = yield* Effect.promise(() => NodeFSP.stat(filePath, { bigint: true }));
        const indexPath = NodePath.join(cwd, ".git", "index");
        const index = Buffer.from(yield* fs.readFile(indexPath));
        expect([index.readUInt32BE(4), index.readUInt32BE(8)]).toEqual([2, 1]);
        const billion = 1_000_000_000n;
        // Forge the entry's stat cache without changing its stored blob ID.
        const fields = [
          stat.ctimeNs / billion,
          stat.ctimeNs % billion,
          stat.mtimeNs / billion,
          stat.mtimeNs % billion,
          stat.dev,
          stat.ino,
          0o100644n,
          stat.uid,
          stat.gid,
          stat.size,
        ];
        fields.forEach((value, field) =>
          index.writeUInt32BE(Number(BigInt.asUintN(32, value)), 12 + 4 * field),
        );
        NodeCrypto.createHash("sha1")
          .update(index.subarray(0, -20))
          .digest()
          .copy(index, index.length - 20);
        yield* fs.writeFile(indexPath, index);

        const checkpoints = yield* CheckpointStore.CheckpointStore;
        const ordinary = yield* checkpoints.captureCheckpoint({
          cwd,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/stat-cache/ordinary"),
        });
        expect(yield* git(cwd, ["show", `${ordinary.commitId}:README.md`])).toBe("safe");
        const strict = yield* checkpoints.captureCheckpoint({
          cwd,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/stat-cache/strict"),
          strictWorkflowCapture: true,
        });
        expect(yield* git(cwd, ["show", `${strict.commitId}:README.md`])).toBe("evil");
        expect(Buffer.from(yield* fs.readFile(indexPath))).toEqual(index);
      }),
    );

    it.effect("rejects captured filter attributes without executing checkout clean drivers", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const fs = yield* FileSystem.FileSystem;
        yield* initRepoWithCommit(cwd);
        const filePath = NodePath.join(cwd, "README.md");
        yield* writeTextFile(NodePath.join(cwd, ".gitattributes"), "README.md filter=probe\n");
        yield* git(cwd, [
          "config",
          "filter.probe.clean",
          "touch .git/filter-ran; cat >/dev/null; echo masked",
        ]);
        yield* git(cwd, ["config", "filter.probe.required", "true"]);
        yield* git(cwd, ["config", "core.worktree", yield* makeTmpDir()]);
        yield* writeTextFile(filePath, "real workflow change\n");
        const checkpoints = yield* CheckpointStore.CheckpointStore;
        const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/no-filter/result");
        const input = {
          cwd,
          checkpointRef,
          strictWorkflowCapture: true,
        };
        expect(yield* Effect.flip(checkpoints.captureCheckpoint(input))).toMatchObject({
          _tag: "VcsProcessExitError",
          detail: "The workflow Git checkpoint does not support checkout filters.",
        });
        expect(yield* git(cwd, ["for-each-ref", checkpointRef])).toBe("");
        expect(yield* fs.exists(NodePath.join(cwd, ".git", "filter-ran"))).toBe(false);
        yield* fs.remove(NodePath.join(cwd, ".gitattributes"));
        const snapshot = yield* checkpoints.captureCheckpoint(input);
        expect(yield* git(cwd, ["show", `${snapshot.commitId}:README.md`])).toBe(
          "real workflow change",
        );
        expect(yield* fs.exists(NodePath.join(cwd, ".git", "filter-ran"))).toBe(false);
      }),
    );

    it.effect("rejects workload-owned sparse rules even if HEAD has been replaced", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const fs = yield* FileSystem.FileSystem;
        yield* initRepoWithCommit(cwd);
        for (const name of ["visible", "excluded"]) {
          yield* fs.makeDirectory(NodePath.join(cwd, name));
          yield* writeTextFile(NodePath.join(cwd, name, "file"), "original\n");
        }
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "sparse baseline"]);
        const head = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* writeTextFile(NodePath.join(cwd, "excluded", "file"), "replacement\n");
        yield* git(cwd, ["commit", "-am", "replacement"]);
        const replacement = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["reset", "--hard", head]);
        yield* git(cwd, ["sparse-checkout", "set", "--cone", "--sparse-index", "visible"]);
        expect(yield* fs.exists(NodePath.join(cwd, "excluded", "file"))).toBe(false);
        yield* git(cwd, ["replace", head, replacement]);
        yield* writeTextFile(NodePath.join(cwd, "visible", "file"), "workflow change\n");
        const checkpoints = yield* CheckpointStore.CheckpointStore;
        const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/sparse/result");
        expect(
          yield* Effect.flip(
            checkpoints.captureCheckpoint({
              cwd,
              checkpointRef,
              strictWorkflowCapture: true,
            }),
          ),
        ).toMatchObject({
          _tag: "VcsProcessExitError",
          detail: "The workflow Git checkpoint requires a full checkout.",
        });
        expect(yield* checkpoints.hasCheckpointRef({ cwd, checkpointRef })).toBe(false);
      }),
    );
  });

  describe("isGitRepository", () => {
    it.effect("returns false when no Git repository is detected", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const checkpointStore = yield* CheckpointStore.CheckpointStore;

        expect(yield* checkpointStore.isGitRepository(tmp)).toBe(false);
      }),
    );

    it.effect("returns true when a Git repository is detected", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;

        expect(yield* checkpointStore.isGitRepository(tmp)).toBe(true);
      }),
    );
  });

  describe("diffCheckpoints", () => {
    it.effect("keeps workflow review objects and refs outside the mutable checkout", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(yield* makeTmpDir());
        const cwd = NodePath.join(root, "worktree");
        const directory = NodePath.join(root, "private-review.git");
        yield* fs.makeDirectory(cwd);
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(NodePath.join(cwd, ".gitignore"), "*.local\n");
        yield* writeTextFile(NodePath.join(cwd, "tracked.local"), "tracked despite ignore\n");
        yield* git(cwd, ["add", ".gitignore"]);
        yield* git(cwd, ["add", "-f", "tracked.local"]);
        yield* git(cwd, ["commit", "-m", "add ignore rule and tracked file"]);
        yield* git(root, ["init", "--bare", directory]);
        yield* git(directory, [
          "fetch",
          "--no-tags",
          `file://${cwd}`,
          `HEAD:${WORKFLOW_REVIEW_SOURCE_REF}`,
        ]);

        yield* Effect.gen(function* () {
          const store = yield* CheckpointStore.CheckpointStore;
          const threadId = ThreadId.make("workflow:private-storage");
          const baselineRef = checkpointRefForThreadTurn(threadId, 0);
          const targetRef = checkpointRefForThreadTurn(threadId, 1);
          const capture = (checkpointRef: CheckpointRef) =>
            store.captureCheckpoint({ cwd, checkpointRef, strictWorkflowCapture: true });
          const baseline = yield* capture(baselineRef);
          yield* git(cwd, ["rm", "--cached", "tracked.local"]);
          yield* git(cwd, ["commit", "-m", "change the workload HEAD"]);
          yield* writeTextFile(NodePath.join(cwd, "README.md"), "the reviewed content\n");
          yield* fs.remove(NodePath.join(cwd, "tracked.local"));
          yield* Effect.sync(() =>
            NodeChildProcess.execFileSync("mkfifo", [NodePath.join(cwd, "ignored.local")]),
          );
          const secret = NodePath.join(root, "control-state");
          yield* writeTextFile(secret, "control canary content\n");
          yield* fs.symlink(secret, NodePath.join(cwd, "link-to-control"));
          const result = yield* capture(targetRef);

          expect(yield* store.hasCheckpointRef({ cwd, checkpointRef: baselineRef })).toBe(false);
          expect(yield* store.hasCheckpointRef({ cwd, checkpointRef: targetRef })).toBe(false);
          expect(
            yield* store.hasCheckpointRef({
              cwd,
              checkpointRef: CheckpointRef.make(result.commitId),
            }),
          ).toBe(false);

          yield* writeTextFile(NodePath.join(cwd, "README.md"), "checkout-owned decoy\n");
          const decoy = yield* store.captureCheckpoint({ cwd, checkpointRef: targetRef });
          yield* git(cwd, ["config", "diff.external", "untrusted-diff-command"]);
          const diff = {
            cwd,
            fromCheckpointRef: CheckpointRef.make(baseline.commitId),
            toCheckpointRef: CheckpointRef.make(result.commitId),
            ignoreWhitespace: false,
            requireComplete: true,
            pinned: true,
          } as const;
          expect(yield* store.resolvePinnedTree({ cwd, checkpointRef: diff.toCheckpointRef })).toBe(
            result.treeId,
          );
          expect(
            yield* store.resolvePinnedTree({
              cwd,
              checkpointRef: CheckpointRef.make(decoy.commitId),
            }),
          ).toBeNull();
          yield* fs.remove(NodePath.join(cwd, ".git"), { recursive: true });
          const patch = yield* store.diffCheckpoints(diff);
          expect(patch).toContain("+the reviewed content");
          expect(patch).toContain("-tracked despite ignore");
          expect(patch).toContain("link-to-control");
          expect(patch).not.toContain("control canary content");
          expect(patch).not.toContain("checkout-owned decoy");
          expect(patch).not.toContain("ignored.local");
          yield* store.deleteCheckpointRefs({ cwd, checkpointRefs: [targetRef], pinned: true });
          expect(yield* store.resolvePinnedTree({ cwd, checkpointRef: targetRef })).toBeNull();
          expect(yield* store.resolvePinnedTree({ cwd, checkpointRef: baselineRef })).toBe(
            baseline.treeId,
          );
        }).pipe(Effect.provideService(WorkflowReviewGitDirectory, directory));
      }),
    );

    it.effect("captures a workflow baseline and review through the workload reader", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(yield* makeTmpDir());
        const cwd = NodePath.join(root, "worktree");
        const directory = NodePath.join(root, "private-review.git");
        yield* fs.makeDirectory(cwd);
        yield* initRepoWithCommit(cwd);
        yield* fs.makeDirectory(NodePath.join(cwd, "other"));
        yield* fs.makeDirectory(NodePath.join(cwd, "examples"));
        const externalIgnore = NodePath.join(root, "external-ignore");
        yield* writeTextFile(externalIgnore, "visible.txt\n");
        yield* fs.symlink(externalIgnore, NodePath.join(cwd, "examples/.gitignore"));
        yield* writeTextFile(NodePath.join(cwd, "other/baseline.txt"), "tracked baseline\n");
        yield* writeTextFile(NodePath.join(cwd, ".gitignore"), ".gitignore\n*.generated\ncache/\n");
        yield* git(cwd, ["add", "-f", ".gitignore", "examples/.gitignore", "other/baseline.txt"]);
        yield* git(cwd, ["commit", "-m", "Track a self-ignored rule and a baseline directory"]);
        yield* git(root, ["init", "--bare", directory]);
        yield* git(directory, [
          "fetch",
          "--no-tags",
          `file://${cwd}`,
          `HEAD:${WORKFLOW_REVIEW_SOURCE_REF}`,
        ]);

        const privateDir = NodePath.join(cwd, "private");
        const privateFile = NodePath.join(privateDir, "prepared.txt");
        yield* fs.makeDirectory(privateDir, { mode: 0o700 });
        yield* fs.writeFileString(privateFile, "setup baseline\n", { mode: 0o600 });
        const exclude = NodePath.join(cwd, ".git/info/exclude");
        yield* fs.writeFileString(exclude, "scratch.cache\n", { mode: 0o600 });
        yield* fs.chmod(exclude, 0o600);
        yield* fs.chmod(NodePath.dirname(exclude), 0o700);
        yield* fs.writeFileString(NodePath.join(cwd, "scratch.cache"), "ignored setup file\n");

        const native = yield* ChildProcessSpawner.ChildProcessSpawner;
        const script = NodeURL.fileURLToPath(
          new URL("../../../../infra/e2b/template/workflow-checkpoint-reader.py", import.meta.url),
        );
        const reads: string[] = [];
        const gitLaunchDirectories: string[] = [];
        let beforeCapture: Effect.Effect<void, VcsError | PlatformError.PlatformError> =
          Effect.void;
        const spawner = ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command)) return native.spawn(command);
          if (command.command === "/opt/launchpad/bin/launchpad-workload") {
            const separator = command.args.indexOf("--");
            const executable = command.args[separator + 1]!;
            const workflow = command.args[0] === "run-workflow";
            const launchCwd = workflow ? command.args[3]! : command.options.cwd;
            if (workflow && executable === "git") {
              gitLaunchDirectories.push(launchCwd!);
              // The coordinator's home is inaccessible after the guest drops to the workload UID.
              if (launchCwd === process.cwd())
                return Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "ChildProcessSpawner",
                    method: "spawn",
                    syscall: "chdir",
                  }),
                );
            }
            command = ChildProcess.make(executable, command.args.slice(separator + 2), {
              ...command.options,
              cwd: launchCwd,
              // Execute the Linux launch protocol using the actual host account and Git binary.
              env: {
                ...command.options.env,
                HOME: process.env.HOME,
                USER: process.env.USER,
                LOGNAME: process.env.LOGNAME,
                PATH: process.env.PATH,
              },
            });
          }
          if (command.command !== "/usr/bin/python3") return native.spawn(command);
          const mode = command.args[2]!;
          reads.push(mode);
          expect(command.options.cwd).toBe(cwd);
          expect(command.args[1]).toBe(
            "/opt/launchpad/bin/launchpad-workflow-checkpoint-reader.py",
          );
          const start = native.spawn(
            ChildProcess.make(command.command, ["-IS", script, mode], command.options),
          );
          return mode === "capture"
            ? beforeCapture.pipe(Effect.orDie, Effect.andThen(start))
            : start;
        });
        const store = yield* withVmWorkloads(
          CheckpointStore.make.pipe(
            Effect.provide(
              Layer.fresh(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layerLocal))),
            ),
          ),
          true,
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        yield* Effect.gen(function* () {
          const threadId = ThreadId.make("workflow:workload-reader");
          const from = checkpointRefForThreadTurn(threadId, 0);
          const to = checkpointRefForThreadTurn(threadId, 1);
          const verify = CheckpointRef.make("refs/t3/workflow-verification/workload-reader");
          const headBefore = yield* git(cwd, ["rev-parse", "HEAD"]);
          const indexBefore = yield* fs.readFile(NodePath.join(cwd, ".git/index"));
          const baseline = yield* store.captureCheckpoint({
            cwd,
            checkpointRef: from,
            strictWorkflowCapture: true,
          });
          expect(gitLaunchDirectories.length).toBeGreaterThan(0);
          expect(gitLaunchDirectories).toContain(cwd);
          expect(gitLaunchDirectories).not.toContain(process.cwd());
          expect(yield* git(cwd, ["rev-parse", "HEAD"])).toBe(headBefore);
          expect(yield* fs.readFile(NodePath.join(cwd, ".git/index"))).toEqual(indexBefore);
          expect(new TextDecoder().decode(baseline.workflowIgnoreRules)).toBe("scratch.cache\n");
          expect(
            yield* git(directory, ["ls-tree", baseline.commitId, "examples/.gitignore"]),
          ).toMatch(/^120000 blob /u);
          yield* fs.writeFileString(privateFile, "reviewed update\n");
          yield* writeTextFile(
            NodePath.join(cwd, "examples/visible.txt"),
            "ignore link not read\n",
          );
          yield* writeTextFile(NodePath.join(cwd, "agent.generated"), "committed despite ignore\n");
          yield* writeTextFile(NodePath.join(cwd, "untracked.generated"), "ignored result\n");
          yield* git(cwd, ["add", "-f", "agent.generated"]);
          yield* git(cwd, ["commit", "-m", "Commit agent output"]);
          yield* fs.remove(NodePath.join(cwd, "other/baseline.txt"));
          const cache = NodePath.join(cwd, "cache");
          yield* fs.makeDirectory(cache);
          yield* writeTextFile(NodePath.join(cache, "entry"), "ignored cache\n");
          yield* fs.chmod(cache, 0o000);
          yield* Effect.addFinalizer(() => fs.chmod(cache, 0o700).pipe(Effect.ignore));
          const capture = (checkpointRef: CheckpointRef) =>
            store.captureCheckpoint({
              cwd,
              checkpointRef,
              strictWorkflowCapture: true,
              ...(baseline.workflowIgnoreRules
                ? { workflowIgnoreRules: baseline.workflowIgnoreRules }
                : {}),
            });
          const result = yield* capture(to);
          const patch = yield* store.diffCheckpoints({
            cwd,
            fromCheckpointRef: CheckpointRef.make(baseline.commitId),
            toCheckpointRef: CheckpointRef.make(result.commitId),
            ignoreWhitespace: false,
            requireComplete: true,
            pinned: true,
          });
          expect(patch).toContain("private/prepared.txt");
          expect(patch).toContain("-setup baseline\n+reviewed update");
          expect(patch).toContain("+committed despite ignore");
          expect(patch).toContain("+ignore link not read");
          expect(patch).toContain("-tracked baseline");
          expect(patch).not.toContain("untracked.generated");
          expect(patch).not.toContain("scratch.cache");
          expect(patch).not.toContain("cache/entry");
          expect(
            yield* store.resolvePinnedTree({
              cwd,
              checkpointRef: CheckpointRef.make(result.commitId),
            }),
          ).toBe(result.treeId);
          expect(reads).toEqual(["exclude", "capture", "exclude", "exclude", "capture", "exclude"]);
          expect((yield* capture(verify)).treeId).toBe(result.treeId);
          yield* writeTextFile(NodePath.join(cwd, "agent.generated"), "edited after review\n");
          expect((yield* capture(verify)).treeId).not.toBe(result.treeId);
          yield* store.deleteCheckpointRefs({ cwd, checkpointRefs: [verify], pinned: true });

          // A real sparse checkout stores its effective setting in worktree configuration.
          yield* git(cwd, ["restore", "agent.generated", "other/baseline.txt"]);
          yield* git(cwd, ["sparse-checkout", "set", "--sparse-index", "private"]);
          expect(yield* fs.exists(NodePath.join(cwd, "other/baseline.txt"))).toBe(false);
          const sparseError = { detail: "The workflow Git checkpoint requires a full checkout." };
          expect(yield* Effect.flip(capture(verify))).toMatchObject(sparseError);
          yield* git(cwd, ["sparse-checkout", "disable"]);
          yield* git(cwd, ["update-index", "--assume-unchanged", "README.md"]);
          yield* git(cwd, ["update-index", "--skip-worktree", "README.md"]);
          expect(yield* Effect.flip(capture(verify))).toMatchObject(sparseError);
          yield* git(cwd, ["update-index", "--no-skip-worktree", "README.md"]);
          yield* git(cwd, ["update-index", "--no-assume-unchanged", "README.md"]);

          // A clean scan can still return exit zero after omitting an unreadable directory.
          const locked = NodePath.join(cwd, "locked");
          yield* fs.makeDirectory(locked);
          yield* writeTextFile(NodePath.join(locked, "result"), "cannot be scanned\n");
          yield* fs.chmod(locked, 0o000);
          if (process.getuid !== undefined && process.getuid() !== 0) {
            expect(
              yield* Effect.flip(capture(verify)).pipe(
                Effect.ensuring(fs.chmod(locked, 0o700).pipe(Effect.orDie)),
              ),
            ).toMatchObject({ detail: "The workflow Git checkpoint paths are unavailable." });
          } else {
            yield* fs.chmod(locked, 0o700);
          }
          yield* fs.remove(locked, { recursive: true });

          const vcs = yield* VcsProcess.VcsProcess;
          beforeCapture = git(cwd, ["config", "--worktree", "core.sparseCheckout", "true"]).pipe(
            Effect.asVoid,
            Effect.provideService(VcsProcess.VcsProcess, vcs),
          );
          expect(yield* Effect.flip(capture(verify))).toMatchObject(sparseError);
          yield* git(cwd, ["config", "--worktree", "core.sparseCheckout", "false"]);
          beforeCapture = fs.writeFileString(
            NodePath.join(cwd, ".gitignore"),
            ".gitignore\ncache/\n",
          );
          expect(yield* Effect.flip(capture(verify))).toMatchObject({
            detail: "The workflow Git checkpoint paths changed during capture.",
          });
          yield* git(cwd, ["restore", ".gitignore"]);
          beforeCapture = git(cwd, [
            "commit",
            "--allow-empty",
            "-m",
            "Change HEAD during capture",
          ]).pipe(Effect.asVoid, Effect.provideService(VcsProcess.VcsProcess, vcs));
          expect(yield* Effect.flip(capture(verify))).toMatchObject({
            detail: "The workflow Git HEAD changed during capture.",
          });
          beforeCapture = Effect.void;
          expect(yield* store.resolvePinnedTree({ cwd, checkpointRef: verify })).toBeNull();
          yield* fs.writeFileString(exclude, "private/\n");
          expect(yield* Effect.flip(capture(to))).toMatchObject({
            detail: "The workflow Git ignore rules changed after preparation.",
          });
          expect(
            yield* store.resolvePinnedTree({
              cwd,
              checkpointRef: CheckpointRef.make(result.commitId),
            }),
          ).toBe(result.treeId);
        }).pipe(
          Effect.provideService(WorkflowReviewGitDirectory, directory),
          Effect.provideService(WorkflowVmGuest, true),
          Effect.provideService(VmWorkloadTracking, true),
        );
      }),
    );

    it.effect(
      "does not fall back to workload Git when a VM is missing private review storage",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const store = yield* CheckpointStore.CheckpointStore;
          const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("workflow:no-store"), 0);
          const capture = store.captureCheckpoint({
            cwd,
            checkpointRef,
            strictWorkflowCapture: true,
          });
          expect(
            yield* Effect.flip(capture.pipe(Effect.provideService(VmWorkloadTracking, true))),
          ).toMatchObject({ detail: "The private workflow checkpoint repository is unavailable." });
          expect(yield* store.hasCheckpointRef({ cwd, checkpointRef })).toBe(false);
        }),
    );
    it.effect("rejects forced-text NULs in strict patches while allowing numstat delimiters", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const fs = yield* FileSystem.FileSystem;
        yield* initRepoWithCommit(cwd);
        const checkpoints = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("workflow-nul-diff");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        yield* writeTextFile(NodePath.join(cwd, ".gitattributes"), "sample.bin diff\n");
        const filePath = NodePath.join(cwd, "sample.bin");
        yield* writeTextFile(filePath, "plain text\n");
        yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: fromCheckpointRef });
        yield* fs.writeFile(filePath, new TextEncoder().encode("plain\0 text\n"));
        yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: toCheckpointRef });
        const input = { cwd, fromCheckpointRef, toCheckpointRef, ignoreWhitespace: false };
        expect(yield* checkpoints.diffCheckpoints(input)).toContain("+plain\0 text");
        expect(
          yield* Effect.flip(checkpoints.diffCheckpoints({ ...input, requireComplete: true })),
        ).toMatchObject({ _tag: "VcsProcessOutputReadError", reason: "nul_byte" });
        const numstat = yield* checkpoints.diffCheckpoints({
          ...input,
          requireComplete: true,
          format: "numstat",
        });
        expect(parseTurnDiffFilesFromNumstat(numstat)).toMatchObject([
          { path: "sample.bin", additions: 1, deletions: 1 },
        ]);
      }),
    );

    it.effect("keeps both pinned sides of a strict diff after refs move", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpoints = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("workflow-pinned-diff");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const decoyRef = checkpointRefForThreadTurn(threadId, 2);
        const readme = NodePath.join(tmp, "README.md");

        const baseline = yield* checkpoints.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(readme, "reviewed result\n");
        const result = yield* checkpoints.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });
        yield* writeTextFile(readme, "unreviewed replacement\n");
        const decoy = yield* checkpoints.captureCheckpoint({ cwd: tmp, checkpointRef: decoyRef });
        yield* git(tmp, ["update-ref", fromCheckpointRef, decoy.commitId]);
        yield* git(tmp, ["update-ref", toCheckpointRef, decoy.commitId]);

        const input = { cwd: tmp, fromCheckpointRef, toCheckpointRef, ignoreWhitespace: false };
        expect(yield* checkpoints.diffCheckpoints(input)).toBe("");
        const pinned = {
          ...input,
          fromCheckpointRef: CheckpointRef.make(baseline.commitId),
          toCheckpointRef: CheckpointRef.make(result.commitId),
          requireComplete: true,
        };
        expect(yield* checkpoints.diffCheckpoints(pinned)).toContain("-# test\n+reviewed result");
        const missing = yield* Effect.flip(
          checkpoints.diffCheckpoints({
            ...pinned,
            toCheckpointRef: CheckpointRef.make("0".repeat(result.commitId.length)),
          }),
        );
        expect(missing._tag).toBe("VcsProcessExitError");
      }),
    );

    it.effect("uses the original checkpoint objects for strict review", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpoints = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("workflow-replacement-diff");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const replacement = checkpointRefForThreadTurn(threadId, 2);
        const readme = NodePath.join(tmp, "README.md");

        yield* checkpoints.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });
        yield* writeTextFile(readme, "reviewed change\n");
        yield* checkpoints.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });
        yield* writeTextFile(readme, "replacement change\n");
        yield* checkpoints.captureCheckpoint({ cwd: tmp, checkpointRef: replacement });
        yield* git(tmp, ["replace", toCheckpointRef, replacement]);

        const input = { cwd: tmp, fromCheckpointRef, toCheckpointRef, ignoreWhitespace: false };
        expect(yield* checkpoints.diffCheckpoints(input)).toContain("+replacement change");
        const strict = yield* checkpoints.diffCheckpoints({ ...input, requireComplete: true });
        expect(strict).toContain("+reviewed change");
        expect(strict).not.toContain("replacement change");
      }),
    );

    it.effect(
      "includes submodule pointers suppressed by repository settings in strict review",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const checkpoints = yield* CheckpointStore.CheckpointStore;
          const threadId = ThreadId.make("workflow-submodule-diff");
          const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
          const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
          const objectIdLength = (yield* git(tmp, ["rev-parse", "HEAD"])).length;
          const previous = "a".repeat(objectIdLength);
          const next = "b".repeat(objectIdLength);

          yield* writeTextFile(
            NodePath.join(tmp, ".gitmodules"),
            '[submodule "dep"]\n\tpath = dependency\n\turl = https://example.invalid/dep\n\tignore = all\n',
          );
          yield* git(tmp, ["add", ".gitmodules"]);
          yield* git(tmp, [
            "update-index",
            "--add",
            "--cacheinfo",
            `160000,${previous},dependency`,
          ]);
          yield* git(tmp, ["commit", "-m", "first pointer"]);
          yield* git(tmp, ["update-ref", fromCheckpointRef, "HEAD"]);
          yield* git(tmp, ["update-index", "--cacheinfo", `160000,${next},dependency`]);
          yield* git(tmp, ["commit", "-m", "updated pointer"]);
          yield* git(tmp, ["update-ref", toCheckpointRef, "HEAD"]);
          yield* git(tmp, ["config", "diff.submodule", "log"]);

          const input = { cwd: tmp, fromCheckpointRef, toCheckpointRef, ignoreWhitespace: false };
          expect(yield* checkpoints.diffCheckpoints(input)).toBe("");
          expect(yield* checkpoints.diffCheckpoints({ ...input, requireComplete: true })).toContain(
            `-Subproject commit ${previous}\n+Subproject commit ${next}`,
          );
        }),
    );

    it.effect("rejects lossy UTF-8 decoding for strict review", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpoints = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("workflow-invalid-utf8");
        const baseline = checkpointRefForThreadTurn(threadId, 0);
        const invalid = checkpointRefForThreadTurn(threadId, 1);
        const valid = checkpointRefForThreadTurn(threadId, 2);
        const script = NodePath.join(tmp, "script.txt");
        yield* fileSystem.writeFile(script, new Uint8Array([0x61, 0x80, 0x0a]));
        yield* checkpoints.captureCheckpoint({ cwd: tmp, checkpointRef: baseline });
        yield* fileSystem.writeFile(script, new Uint8Array([0x61, 0x81, 0x0a]));
        yield* checkpoints.captureCheckpoint({ cwd: tmp, checkpointRef: invalid });

        const input = {
          cwd: tmp,
          fromCheckpointRef: baseline,
          toCheckpointRef: invalid,
          ignoreWhitespace: false,
        };
        expect(yield* checkpoints.diffCheckpoints(input)).toContain("-a�\n+a�");
        const error = yield* Effect.flip(
          checkpoints.diffCheckpoints({ ...input, requireComplete: true }),
        );
        expect(error).toMatchObject({ _tag: "VcsProcessOutputReadError", reason: "invalid_utf8" });

        yield* fileSystem.remove(script);
        yield* writeTextFile(NodePath.join(tmp, "valid.txt"), "a�\n");
        yield* checkpoints.captureCheckpoint({ cwd: tmp, checkpointRef: valid });
        const empty = checkpointRefForThreadTurn(threadId, 3);
        yield* fileSystem.remove(NodePath.join(tmp, "valid.txt"));
        yield* checkpoints.captureCheckpoint({ cwd: tmp, checkpointRef: empty });
        expect(
          yield* checkpoints.diffCheckpoints({
            ...input,
            fromCheckpointRef: empty,
            toCheckpointRef: valid,
            requireComplete: true,
          }),
        ).toContain("+a�");
      }),
    );

    it.effect("rejects Git binary summaries without matching identical hunk text", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpoints = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("workflow-binary-diff");
        const baseline = checkpointRefForThreadTurn(threadId, 0);
        const literal = checkpointRefForThreadTurn(threadId, 1);
        const masked = checkpointRefForThreadTurn(threadId, 2);
        const binary = checkpointRefForThreadTurn(threadId, 3);
        const summary = "Binary files a/old b/new differ";
        const readme = NodePath.join(tmp, "README.md");
        const maskedText = NodePath.join(tmp, "masked.txt");
        const binaryFile = NodePath.join(tmp, "image.bin");
        yield* writeTextFile(NodePath.join(tmp, ".gitattributes"), "masked.txt -diff\n");
        yield* writeTextFile(readme, `${summary}\nremoved\n`);
        yield* writeTextFile(maskedText, "before\n");
        yield* fileSystem.writeFile(binaryFile, new Uint8Array([0x00, 0x01]));
        yield* checkpoints.captureCheckpoint({ cwd: tmp, checkpointRef: baseline });

        yield* writeTextFile(
          readme,
          `${summary}\n${summary}\nseparator\u2028${summary}\u2028end\n`,
        );
        yield* checkpoints.captureCheckpoint({ cwd: tmp, checkpointRef: literal });
        const input = {
          cwd: tmp,
          fromCheckpointRef: baseline,
          toCheckpointRef: literal,
          ignoreWhitespace: false,
        };
        const patch = yield* checkpoints.diffCheckpoints({ ...input, requireComplete: true });
        expect(patch).toContain(` ${summary}\n`);
        expect(patch).toContain(`+${summary}\n`);

        yield* writeTextFile(maskedText, "after\n");
        yield* checkpoints.captureCheckpoint({ cwd: tmp, checkpointRef: masked });
        yield* fileSystem.writeFile(binaryFile, new Uint8Array([0x00, 0x02]));
        yield* checkpoints.captureCheckpoint({ cwd: tmp, checkpointRef: binary });
        for (const [fromCheckpointRef, toCheckpointRef, path] of [
          [literal, masked, "masked.txt"],
          [masked, binary, "image.bin"],
        ] as const) {
          const range = { ...input, fromCheckpointRef, toCheckpointRef };
          expect(yield* checkpoints.diffCheckpoints(range)).toContain(
            `diff --git a/${path} b/${path}`,
          );
          const error = yield* Effect.flip(
            checkpoints.diffCheckpoints({ ...range, requireComplete: true }),
          );
          expect(error).toMatchObject({
            _tag: "VcsProcessOutputReadError",
            reason: "binary_summary",
          });
        }
      }),
    );

    it.effect("returns complete checkpoint patches or fails at the output limit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("strict-workflow-review");
        const baseline = checkpointRefForThreadTurn(threadId, 0);
        const firstTurn = checkpointRefForThreadTurn(threadId, 1);
        const emptyTurn = checkpointRefForThreadTurn(threadId, 2);
        const largeTurn = checkpointRefForThreadTurn(threadId, 3);
        const script = NodePath.join(tmp, "check.py");

        yield* writeTextFile(script, 'if ready:\n    print("ready")\nprint("finish")\n');
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: baseline });
        yield* writeTextFile(script, 'if ready:\n    print("ready")\n    print("finish")\n');
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: firstTurn });
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: emptyTurn });

        const input = {
          cwd: tmp,
          fromCheckpointRef: baseline,
          toCheckpointRef: firstTurn,
          ignoreWhitespace: false,
          requireComplete: true,
        };
        const patch = yield* checkpointStore.diffCheckpoints(input);
        expect(patch).toContain('-print("finish")\n+    print("finish")');
        expect(
          yield* checkpointStore.diffCheckpoints({
            ...input,
            fromCheckpointRef: firstTurn,
            toCheckpointRef: emptyTurn,
          }),
        ).toBe("");

        yield* writeTextFile(
          NodePath.join(tmp, "large.txt"),
          `${"a".repeat(100)}\n`.repeat(100_000),
        );
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: largeTurn });
        const error = yield* Effect.flip(
          checkpointStore.diffCheckpoints({
            ...input,
            fromCheckpointRef: emptyTurn,
            toCheckpointRef: largeTurn,
          }),
        );
        expect(error).toMatchObject({ _tag: "VcsProcessOutputLimitError", stream: "stdout" });
      }),
    );

    it.effect("returns full oversized checkpoint diffs without truncation", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(NodePath.join(tmp, "README.md"), buildLargeText());
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(diff).toContain("diff --git");
        expect(diff).not.toContain("[truncated]");
        expect(diff).toContain("+line 04999");
      }),
    );

    it.effect("keeps a/ and b/ patch prefixes when the repository disables them", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["config", "diff.noprefix", "true"]);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-noprefix");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(NodePath.join(tmp, "README.md"), "# changed\n");
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
        });

        expect(diff).toContain("diff --git a/README.md b/README.md");
      }),
    );

    it.effect("can hide indentation churn when changes wrap existing lines", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-whitespace");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        const componentPath = NodePath.join(tmp, "Component.tsx");
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      <h1>Title</h1>",
            "      <p>Body</p>",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      {isReady ? (",
            "        <div>",
            "          <h1>Title</h1>",
            "          <p>Body</p>",
            "        </div>",
            "      ) : null}",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const normalDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
        });
        const whitespaceIgnoredDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(normalDiff).toContain("diff --git");
        expect(normalDiff).toContain("-      <h1>Title</h1>");
        expect(normalDiff).toContain("+          <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).toContain("diff --git");
        expect(whitespaceIgnoredDiff).toContain("+      {isReady ? (");
        expect(whitespaceIgnoredDiff).toContain("+        <div>");
        expect(whitespaceIgnoredDiff).not.toContain("-      <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).not.toContain("+          <h1>Title</h1>");

        for (const ignoreWhitespace of [false, true]) {
          const numstat = yield* checkpointStore.diffCheckpoints({
            cwd: tmp,
            fromCheckpointRef,
            toCheckpointRef,
            ignoreWhitespace,
            format: "numstat",
          });
          expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
            {
              path: "Component.tsx",
              additions: ignoreWhitespace ? 4 : 6,
              deletions: ignoreWhitespace ? 0 : 2,
            },
          ]);
        }
      }),
    );
  });

  describe("checkpoint file summaries", () => {
    it.effect("counts changes whose full patch exceeds the output limit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("large-checkpoint-summary");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const filePath = NodePath.join(tmp, "README.md");
        const lineCount = 20_000;
        yield* writeTextFile(filePath, `${"before".repeat(50)}\n`.repeat(lineCount));
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });
        yield* writeTextFile(filePath, `${"after".repeat(60)}\n`.repeat(lineCount));
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const numstat = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
          format: "numstat",
        });

        expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
          { path: "README.md", additions: lineCount, deletions: lineCount },
        ]);
        expect(numstat.length).toBeLessThan(100);
      }),
    );

    it.effect("preserves file paths and turn ranges without changing the user index", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["config", "diff.renames", "copies"]);
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("checkpoint-summary-paths");
        const baseline = checkpointRefForThreadTurn(threadId, 0);
        const firstTurn = checkpointRefForThreadTurn(threadId, 1);
        const secondTurn = checkpointRefForThreadTurn(threadId, 2);
        const copiedText = Array.from({ length: 20 }, (_, index) => `copy line ${index}\n`).join(
          "",
        );
        const platform = yield* HostProcessPlatform;
        const renamedPath = platform === "win32" ? "renamed café.txt" : "renamed\tcafé\nname.txt";
        const addedPath = platform === "win32" ? "new café.txt" : "new\tfile\n名.txt";
        for (const [path, contents] of Object.entries({
          "copy-source.txt": copiedText,
          "deleted.txt": "delete me\n",
          "rename-old.txt": "before\nkeep one\nkeep two\nkeep three\n",
          "binary.bin": "\0before",
        })) {
          yield* writeTextFile(NodePath.join(tmp, path), contents);
        }
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: baseline });

        yield* fileSystem.rename(
          NodePath.join(tmp, "rename-old.txt"),
          NodePath.join(tmp, renamedPath),
        );
        yield* fileSystem.remove(NodePath.join(tmp, "deleted.txt"));
        for (const [path, contents] of Object.entries({
          "copy-source.txt": `${copiedText}one more\n`,
          "copied.txt": copiedText,
          [renamedPath]: "after\nkeep one\nkeep two\nkeep three\n",
          "binary.bin": "\0after",
          "empty.txt": "",
          [addedPath]: "first\nsecond\n",
        })) {
          yield* writeTextFile(NodePath.join(tmp, path), contents);
        }
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: firstTurn });
        const userIndex = yield* fileSystem.readFile(NodePath.join(tmp, ".git/index"));
        const input = {
          cwd: tmp,
          fromCheckpointRef: baseline,
          toCheckpointRef: firstTurn,
          ignoreWhitespace: false,
          format: "numstat" as const,
        };
        const firstSummary = parseTurnDiffFilesFromNumstat(
          yield* checkpointStore.diffCheckpoints(input),
        );
        const expectedFiles = [
          { path: "binary.bin", additions: 0, deletions: 0 },
          { path: "copied.txt", additions: 0, deletions: 0 },
          { path: "copy-source.txt", additions: 1, deletions: 0 },
          { path: "deleted.txt", additions: 0, deletions: 1 },
          { path: "empty.txt", additions: 0, deletions: 0 },
          { path: addedPath, additions: 2, deletions: 0 },
          { path: renamedPath, additions: 1, deletions: 1 },
        ].toSorted((left, right) => left.path.localeCompare(right.path));
        expect(firstSummary).toEqual(expectedFiles);

        yield* fileSystem.remove(NodePath.join(tmp, "empty.txt"));
        yield* writeTextFile(NodePath.join(tmp, "copy-source.txt"), "replacement\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: secondTurn });
        const secondSummary = parseTurnDiffFilesFromNumstat(
          yield* checkpointStore.diffCheckpoints({
            ...input,
            fromCheckpointRef: firstTurn,
            toCheckpointRef: secondTurn,
          }),
        );
        expect(secondSummary).toEqual([
          { path: "copy-source.txt", additions: 1, deletions: 21 },
          { path: "empty.txt", additions: 0, deletions: 0 },
        ]);

        const inclusiveSummary = parseTurnDiffFilesFromNumstat(
          yield* checkpointStore.diffCheckpoints({ ...input, toCheckpointRef: secondTurn }),
        );
        expect(inclusiveSummary).toEqual(
          expectedFiles
            .filter((file) => file.path !== "empty.txt")
            .map((file) =>
              file.path === "copy-source.txt" ? { ...file, additions: 1, deletions: 20 } : file,
            ),
        );
        expect(
          yield* checkpointStore.diffCheckpoints({ ...input, toCheckpointRef: baseline }),
        ).toBe("");
        expect(yield* fileSystem.readFile(NodePath.join(tmp, ".git/index"))).toEqual(userIndex);
      }),
    );

    it.effect("uses HEAD for a missing baseline only when requested", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("checkpoint-summary-fallback");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        yield* writeTextFile(NodePath.join(tmp, "README.md"), "changed\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });
        const input = {
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
          format: "numstat" as const,
        };

        const error = yield* Effect.flip(checkpointStore.diffCheckpoints(input));
        expect(error._tag).toBe("VcsProcessExitError");
        const numstat = yield* checkpointStore.diffCheckpoints({
          ...input,
          fallbackFromToHead: true,
        });
        expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
          { path: "README.md", additions: 1, deletions: 1 },
        ]);
      }),
    );
  });
});
