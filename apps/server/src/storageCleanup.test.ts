import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vite-plus/test";
import * as Config from "./config.ts";
import * as Settings from "./serverSettings.ts";
import * as Cleanup from "./storageCleanup.ts";
import { GitManager } from "./git/GitManager.ts";
import { GitVcsDriver } from "./vcs/GitVcsDriver.ts";
import { TerminalManager } from "./terminal/Manager.ts";
import { ProviderService } from "./provider/Services/ProviderService.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  ThreadCleanupError,
} from "./orchestration/Services/ThreadDeletionReactor.ts";

it.layer(NodeServices.layer)("storage cleanup deletion ownership", (it) => {
  it.effect.each(["blocked", "late-blocked", "settled"] as const)(
    "checks every deleted task sharing a directory, including disabled cleanup policies (%s)",
    (scenario) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "storage-cleanup-" });
        const worktreesDir = `${root}/worktrees`;
        const worktreePath = `${worktreesDir}/shared`;
        yield* fs.makeDirectory(worktreePath, { recursive: true });
        yield* fs.writeFileString(`${worktreePath}/.git`, "gitdir: fixture");
        const projectId = ProjectId.make("cleanup-enabled");
        const otherProject = ProjectId.make("cleanup-disabled");
        const blockedId = ThreadId.make("unsettled-deletion");
        const started = yield* Deferred.make<void>();
        let blocked = scenario === "blocked";
        let gitReads = 0;
        const removed: string[] = [];
        const checked: string[] = [];
        const deleted = [
          { id: ThreadId.make("candidate"), projectId },
          { id: blockedId, projectId: otherProject },
        ].map((thread) => ({
          ...thread,
          branch: "feature",
          worktreePath,
          workspaceRoot: `${root}/repository`,
          deletedAt: "2026-01-01T00:00:00.000Z",
        }));
        const snapshot = {
          snapshotSequence: 10,
          projects: [],
          threads: [],
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        const deps = Layer.mergeAll(
          Config.layerTest(root, root),
          Settings.layerTest({
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: null,
                worktreeOnDelete: true,
                worktreeOnMerge: false,
                worktreeUnchanged: false,
              },
            },
            projectSettingsOverrides: { [otherProject]: { worktreeCleanup: { mode: "off" } } },
            storageCleanup: { logsAfterDays: null, browserArtifactsAfterDays: null },
          }),
          Layer.mock(ProjectionSnapshotQuery, {
            getDeletedWorktreeThreads: () =>
              Deferred.succeed(started, undefined).pipe(Effect.as(deleted)),
            getShellSnapshot: () => Effect.succeed(snapshot),
            getArchivedShellSnapshot: () => Effect.succeed(snapshot),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 10 }),
          }),
          Layer.mock(OrchestrationEngineService, {
            subscribeDomainEvents: Effect.succeed(Stream.never),
          }),
          Layer.mock(ThreadDeletionReactor, {
            drainThrough: (_sequence, id) =>
              Effect.suspend(() => {
                checked.push(id!);
                return id === blockedId && blocked
                  ? Effect.fail(
                      new ThreadCleanupError({
                        threadId: blockedId,
                        message: "Process still owns directory",
                      }),
                    )
                  : Effect.void;
              }),
          }),
          Layer.mock(TerminalManager, { subscribeMetadata: () => Effect.succeed(() => {}) }),
          Layer.mock(ProviderService, { listSessions: () => Effect.succeed([]) }),
          Layer.mock(GitManager, { invalidateStatus: () => Effect.void }),
          Layer.mock(GitVcsDriver, {
            statusDetailsLocal: () =>
              Effect.succeed({
                isRepo: true,
                hasOriginRemote: false,
                isDefaultBranch: false,
                branch: "feature",
                upstreamRef: null,
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: false,
                aheadCount: 0,
                behindCount: 0,
                aheadOfDefaultCount: 0,
              }),
            resolveCommit: () => Effect.succeed({ commitSha: "abc" }),
            execute: () =>
              Effect.sync(() => {
                if (++gitReads === 2 && scenario === "late-blocked") blocked = true;
                return {
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout: "",
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                };
              }),
            removeWorktree: (input) =>
              Effect.sync(() => {
                removed.push(input.path);
              }),
          }),
        );
        yield* Effect.gen(function* () {
          const cleanup = yield* Cleanup.StorageCleanup;
          yield* cleanup.start();
          yield* Deferred.await(started);
          yield* cleanup.drain;
          expect(checked).toContain(blockedId);
          expect(removed).toEqual(scenario === "settled" ? [worktreePath] : []);
        }).pipe(Effect.provide(Cleanup.layer.pipe(Layer.provide(deps))));
      }),
  );
});
