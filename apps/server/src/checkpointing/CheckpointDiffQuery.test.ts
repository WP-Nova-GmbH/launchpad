import { CheckpointRef, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkflowRunStore } from "../jobs/WorkflowRunStore.ts";
import { checkpointRefForThreadTurn } from "./Utils.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { CheckpointThreadNotFoundError } from "./Errors.ts";

const captured = { commitId: "b".repeat(40), treeId: "c".repeat(40) };

function makeThreadCheckpointContext(input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
}): ProjectionSnapshotQuery.ProjectionThreadCheckpointContext {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    workspaceRoot: input.workspaceRoot,
    worktreePath: input.worktreePath,
    checkpoints: [
      {
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: input.checkpointTurnCount,
        checkpointRef: input.checkpointRef,
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

describe("CheckpointDiffQuery.layer", () => {
  it.effect("uses the narrow full-thread context lookup for all-turns diffs", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-full-thread");
      const threadId = ThreadId.make("thread-full-thread");
      const toCheckpointRef = checkpointRefForThreadTurn(threadId, 4);
      let getThreadCheckpointContextCalls = 0;
      let getFullThreadDiffContextCalls = 0;
      const diffCheckpointsCalls: Array<{
        readonly fromCheckpointRef: CheckpointRef;
        readonly toCheckpointRef: CheckpointRef;
        readonly cwd: string;
        readonly ignoreWhitespace: boolean;
      }> = [];

      const checkpointStore: CheckpointStore.CheckpointStore["Service"] = {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint: () => Effect.succeed(captured),
        hasCheckpointRef: () => Effect.succeed(true),
        resolvePinnedTree: () => Effect.succeed(null),
        restoreCheckpoint: () => Effect.succeed(true),
        diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace }) =>
          Effect.sync(() => {
            diffCheckpointsCalls.push({
              fromCheckpointRef,
              toCheckpointRef,
              cwd,
              ignoreWhitespace,
            });
            return "full thread diff patch";
          }),
        deleteCheckpointRefs: () => Effect.void,
      };

      const layer = CheckpointDiffQuery.layer.pipe(
        Layer.provideMerge(Layer.succeed(CheckpointStore.CheckpointStore, checkpointStore)),
        Layer.provideMerge(
          Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
            getThreadSubscriptionAnchor: () => Effect.succeedNone,
            getUserInputActivity: () => Effect.die("unused"),
            listActivitiesByKind: () => Effect.die("unused"),
            getCommandReadModel: () =>
              Effect.die("CheckpointDiffQuery should not request the command read model"),
            getSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
            getShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
            getDeletedWorktreeThreads: () => Effect.die("unused"),
            getArchivedShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
            getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
            getEventReplayStats: () => Effect.die("unused"),
            getActiveProjectByWorkspaceRoot: () => Effect.succeedNone,
            getProjectShells: () => Effect.die("unused"),
            getProjectShellById: () => Effect.succeedNone,
            getFirstActiveThreadIdByProjectId: () => Effect.succeedNone,
            getImportedAgentSessionSources: () => Effect.die("unused"),
            getThreadCheckpointContext: () =>
              Effect.sync(() => {
                getThreadCheckpointContextCalls += 1;
                return Option.none();
              }),
            getFullThreadDiffContext: () =>
              Effect.sync(() => {
                getFullThreadDiffContextCalls += 1;
                return Option.some({
                  threadId,
                  projectId,
                  workspaceRoot: "/tmp/workspace",
                  worktreePath: "/tmp/worktree",
                  latestCheckpointTurnCount: 4,
                  toCheckpointRef,
                });
              }),
            getThreadRuntimeContext: () => Effect.die("unused"),
            getTurnStartMessage: () => Effect.die("unused"),
            getThreadShellById: () => Effect.succeedNone,
            getThreadDetailById: () => Effect.succeedNone,
            getThreadDetailSnapshot: () => Effect.succeedNone,
            searchThreads: () => Effect.succeed({ matches: [] }),
          }),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        return yield* query.getFullThreadDiff({
          threadId,
          toTurnCount: 4,
          ignoreWhitespace: true,
        });
      }).pipe(Effect.provide(layer));

      expect(getThreadCheckpointContextCalls).toBe(0);
      expect(getFullThreadDiffContextCalls).toBe(1);
      expect(diffCheckpointsCalls).toEqual([
        {
          cwd: "/tmp/worktree",
          fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
          toCheckpointRef,
          ignoreWhitespace: true,
        },
      ]);
      expect(result).toEqual({
        threadId,
        fromTurnCount: 0,
        toTurnCount: 4,
        diff: "full thread diff patch",
      });
    }),
  );

  it.effect(
    "uses immutable commit pins for strict review and refs for ordinary first-turn diffs",
    () =>
      Effect.gen(function* () {
        const projectId = ProjectId.make("project-1");
        const threadId = ThreadId.make("thread-1");
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const expectedTurnId = TurnId.make("turn-1");
        const baselineCommitId = "a".repeat(40);
        let pinAvailable = true;
        const diffCheckpointsCalls: Array<{
          readonly fromCheckpointRef: CheckpointRef;
          readonly toCheckpointRef: CheckpointRef;
          readonly cwd: string;
          readonly ignoreWhitespace: boolean;
          readonly requireComplete?: boolean;
        }> = [];

        const threadCheckpointContext = makeThreadCheckpointContext({
          projectId,
          threadId,
          workspaceRoot: "/tmp/workspace",
          worktreePath: null,
          checkpointTurnCount: 1,
          checkpointRef: toCheckpointRef,
        });

        const checkpointStore: CheckpointStore.CheckpointStore["Service"] = {
          isGitRepository: () => Effect.succeed(true),
          captureCheckpoint: () => Effect.succeed(captured),
          hasCheckpointRef: () => Effect.succeed(true),
          resolvePinnedTree: () => Effect.succeed(null),
          restoreCheckpoint: () => Effect.succeed(true),
          diffCheckpoints: ({
            fromCheckpointRef,
            toCheckpointRef,
            cwd,
            ignoreWhitespace,
            requireComplete,
          }) =>
            Effect.sync(() => {
              diffCheckpointsCalls.push({
                fromCheckpointRef,
                toCheckpointRef,
                cwd,
                ignoreWhitespace,
                ...(requireComplete ? { requireComplete } : {}),
              });
              return requireComplete ? "" : "diff patch";
            }),
          deleteCheckpointRefs: () => Effect.void,
        };

        const layer = CheckpointDiffQuery.layer.pipe(
          Layer.provide(
            Layer.effect(
              WorkflowRunStore,
              Effect.map(WorkflowRunStore, (defaults) => ({
                ...defaults,
                getCheckpointPinForTurn: (thread, turn, count) =>
                  Effect.sync(() => {
                    expect({ thread, turn, count }).toEqual({
                      thread: threadId,
                      turn: expectedTurnId,
                      count: 1,
                    });
                    return pinAvailable
                      ? { ...captured, baselineCommitId, checkpointRef: toCheckpointRef }
                      : null;
                  }),
              })),
            ),
          ),
          Layer.provideMerge(Layer.succeed(CheckpointStore.CheckpointStore, checkpointStore)),
          Layer.provideMerge(
            Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
              getThreadSubscriptionAnchor: () => Effect.succeedNone,
              getUserInputActivity: () => Effect.die("unused"),
              listActivitiesByKind: () => Effect.die("unused"),
              getCommandReadModel: () =>
                Effect.die("CheckpointDiffQuery should not request the command read model"),
              getSnapshot: () =>
                Effect.die(
                  "CheckpointDiffQuery should not request the full orchestration snapshot",
                ),
              getShellSnapshot: () =>
                Effect.die(
                  "CheckpointDiffQuery should not request the orchestration shell snapshot",
                ),
              getDeletedWorktreeThreads: () => Effect.die("unused"),
              getArchivedShellSnapshot: () =>
                Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
              getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
              getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
              getEventReplayStats: () => Effect.die("unused"),
              getActiveProjectByWorkspaceRoot: () => Effect.succeedNone,
              getProjectShells: () => Effect.die("unused"),
              getProjectShellById: () => Effect.succeedNone,
              getFirstActiveThreadIdByProjectId: () => Effect.succeedNone,
              getImportedAgentSessionSources: () => Effect.die("unused"),
              getThreadCheckpointContext: () => Effect.succeedSome(threadCheckpointContext),
              getFullThreadDiffContext: () => Effect.die("unused"),
              getThreadRuntimeContext: () => Effect.die("unused"),
              getTurnStartMessage: () => Effect.die("unused"),
              getThreadShellById: () => Effect.succeedNone,
              getThreadDetailById: () => Effect.succeedNone,
              getThreadDetailSnapshot: () => Effect.succeedNone,
              searchThreads: () => Effect.succeed({ matches: [] }),
            }),
          ),
        );

        const { result, strictResult } = yield* Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
          const input = {
            threadId,
            fromTurnCount: 0,
            toTurnCount: 1,
            ignoreWhitespace: true,
          };
          const result = yield* query.getTurnDiff(input);
          const strict = { ...input, strictWorkflowReview: true, expectedTurnId };
          const strictResult = yield* query.getTurnDiff(strict);
          const mismatchedTurn = yield* Effect.flip(
            query.getTurnDiff({ ...strict, expectedTurnId: TurnId.make("reused-count") }),
          );
          expect(mismatchedTurn._tag).toBe("CheckpointWorkflowPinUnavailableError");
          const oldRequest = yield* Effect.flip(
            query.getTurnDiff({ ...input, strictWorkflowReview: true }),
          );
          expect(oldRequest._tag).toBe("CheckpointWorkflowPinUnavailableError");
          pinAvailable = false;
          const missingPin = yield* Effect.flip(query.getTurnDiff(strict));
          expect(missingPin._tag).toBe("CheckpointWorkflowPinUnavailableError");
          return { result, strictResult };
        }).pipe(Effect.provide(layer));

        const expectedFromRef = checkpointRefForThreadTurn(threadId, 0);
        expect(diffCheckpointsCalls).toEqual([
          {
            cwd: "/tmp/workspace",
            fromCheckpointRef: expectedFromRef,
            toCheckpointRef,
            ignoreWhitespace: true,
          },
          {
            cwd: "/tmp/workspace",
            fromCheckpointRef: CheckpointRef.make(baselineCommitId),
            toCheckpointRef: CheckpointRef.make(captured.commitId),
            ignoreWhitespace: false,
            requireComplete: true,
          },
        ]);
        expect(result).toEqual({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          diff: "diff patch",
        });
        expect(strictResult).toEqual({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          diff: "",
          completeWorkflowReview: true,
          targetTurnId: expectedTurnId,
        });
      }),
  );

  it.effect("defaults to hide whitespace changes", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-default-whitespace");
      const threadId = ThreadId.make("thread-default-whitespace");
      const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
      const diffCheckpointsCalls: Array<{ readonly ignoreWhitespace: boolean }> = [];

      const threadCheckpointContext = makeThreadCheckpointContext({
        projectId,
        threadId,
        workspaceRoot: "/tmp/workspace",
        worktreePath: null,
        checkpointTurnCount: 1,
        checkpointRef: toCheckpointRef,
      });

      const checkpointStore: CheckpointStore.CheckpointStore["Service"] = {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint: () => Effect.succeed(captured),
        hasCheckpointRef: () => Effect.succeed(true),
        resolvePinnedTree: () => Effect.succeed(null),
        restoreCheckpoint: () => Effect.succeed(true),
        diffCheckpoints: ({ ignoreWhitespace }) =>
          Effect.sync(() => {
            diffCheckpointsCalls.push({ ignoreWhitespace });
            return "diff patch";
          }),
        deleteCheckpointRefs: () => Effect.void,
      };

      const layer = CheckpointDiffQuery.layer.pipe(
        Layer.provideMerge(Layer.succeed(CheckpointStore.CheckpointStore, checkpointStore)),
        Layer.provideMerge(
          Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
            getThreadSubscriptionAnchor: () => Effect.succeedNone,
            getUserInputActivity: () => Effect.die("unused"),
            listActivitiesByKind: () => Effect.die("unused"),
            getCommandReadModel: () =>
              Effect.die("CheckpointDiffQuery should not request the command read model"),
            getSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
            getShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
            getDeletedWorktreeThreads: () => Effect.die("unused"),
            getArchivedShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
            getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
            getEventReplayStats: () => Effect.die("unused"),
            getActiveProjectByWorkspaceRoot: () => Effect.succeedNone,
            getProjectShells: () => Effect.die("unused"),
            getProjectShellById: () => Effect.succeedNone,
            getFirstActiveThreadIdByProjectId: () => Effect.succeedNone,
            getImportedAgentSessionSources: () => Effect.die("unused"),
            getThreadCheckpointContext: () => Effect.succeedSome(threadCheckpointContext),
            getFullThreadDiffContext: () => Effect.die("unused"),
            getThreadRuntimeContext: () => Effect.die("unused"),
            getTurnStartMessage: () => Effect.die("unused"),
            getThreadShellById: () => Effect.succeedNone,
            getThreadDetailById: () => Effect.succeedNone,
            getThreadDetailSnapshot: () => Effect.succeedNone,
            searchThreads: () => Effect.succeed({ matches: [] }),
          }),
        ),
      );

      yield* Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
      }).pipe(Effect.provide(layer));

      expect(diffCheckpointsCalls).toEqual([{ ignoreWhitespace: true }]);
    }),
  );

  it.effect("does not preflight checkpoint refs before diffing", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-no-preflight");
      const threadId = ThreadId.make("thread-no-preflight");
      const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
      let hasCheckpointRefCallCount = 0;

      const threadCheckpointContext = makeThreadCheckpointContext({
        projectId,
        threadId,
        workspaceRoot: "/tmp/workspace",
        worktreePath: null,
        checkpointTurnCount: 1,
        checkpointRef: toCheckpointRef,
      });

      const checkpointStore: CheckpointStore.CheckpointStore["Service"] = {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint: () => Effect.succeed(captured),
        hasCheckpointRef: () =>
          Effect.sync(() => {
            hasCheckpointRefCallCount += 1;
            return true;
          }),
        resolvePinnedTree: () => Effect.succeed(null),
        restoreCheckpoint: () => Effect.succeed(true),
        diffCheckpoints: () => Effect.succeed("diff patch"),
        deleteCheckpointRefs: () => Effect.void,
      };

      const layer = CheckpointDiffQuery.layer.pipe(
        Layer.provideMerge(Layer.succeed(CheckpointStore.CheckpointStore, checkpointStore)),
        Layer.provideMerge(
          Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
            getThreadSubscriptionAnchor: () => Effect.succeedNone,
            getUserInputActivity: () => Effect.die("unused"),
            listActivitiesByKind: () => Effect.die("unused"),
            getCommandReadModel: () =>
              Effect.die("CheckpointDiffQuery should not request the command read model"),
            getSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
            getShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
            getDeletedWorktreeThreads: () => Effect.die("unused"),
            getArchivedShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
            getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
            getEventReplayStats: () => Effect.die("unused"),
            getActiveProjectByWorkspaceRoot: () => Effect.succeedNone,
            getProjectShells: () => Effect.die("unused"),
            getProjectShellById: () => Effect.succeedNone,
            getFirstActiveThreadIdByProjectId: () => Effect.succeedNone,
            getImportedAgentSessionSources: () => Effect.die("unused"),
            getThreadCheckpointContext: () => Effect.succeedSome(threadCheckpointContext),
            getFullThreadDiffContext: () => Effect.die("unused"),
            getThreadRuntimeContext: () => Effect.die("unused"),
            getTurnStartMessage: () => Effect.die("unused"),
            getThreadShellById: () => Effect.succeedNone,
            getThreadDetailById: () => Effect.succeedNone,
            getThreadDetailSnapshot: () => Effect.succeedNone,
            searchThreads: () => Effect.succeed({ matches: [] }),
          }),
        ),
      );

      yield* Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          ignoreWhitespace: true,
        });
      }).pipe(Effect.provide(layer));

      expect(hasCheckpointRefCallCount).toBe(0);
    }),
  );

  it.effect("fails when the thread is missing from the snapshot", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-missing");

      const checkpointStore: CheckpointStore.CheckpointStore["Service"] = {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint: () => Effect.succeed(captured),
        hasCheckpointRef: () => Effect.succeed(true),
        resolvePinnedTree: () => Effect.succeed(null),
        restoreCheckpoint: () => Effect.succeed(true),
        diffCheckpoints: () => Effect.succeed(""),
        deleteCheckpointRefs: () => Effect.void,
      };

      const layer = CheckpointDiffQuery.layer.pipe(
        Layer.provideMerge(Layer.succeed(CheckpointStore.CheckpointStore, checkpointStore)),
        Layer.provideMerge(
          Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
            getThreadSubscriptionAnchor: () => Effect.succeedNone,
            getUserInputActivity: () => Effect.die("unused"),
            listActivitiesByKind: () => Effect.die("unused"),
            getCommandReadModel: () =>
              Effect.die("CheckpointDiffQuery should not request the command read model"),
            getSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
            getShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
            getDeletedWorktreeThreads: () => Effect.die("unused"),
            getArchivedShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
            getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
            getEventReplayStats: () => Effect.die("unused"),
            getActiveProjectByWorkspaceRoot: () => Effect.succeedNone,
            getProjectShells: () => Effect.die("unused"),
            getProjectShellById: () => Effect.succeedNone,
            getFirstActiveThreadIdByProjectId: () => Effect.succeedNone,
            getImportedAgentSessionSources: () => Effect.die("unused"),
            getThreadCheckpointContext: () => Effect.succeedNone,
            getFullThreadDiffContext: () => Effect.succeedNone,
            getThreadRuntimeContext: () => Effect.die("unused"),
            getTurnStartMessage: () => Effect.die("unused"),
            getThreadShellById: () => Effect.succeedNone,
            getThreadDetailById: () => Effect.succeedNone,
            getThreadDetailSnapshot: () => Effect.succeedNone,
            searchThreads: () => Effect.succeed({ matches: [] }),
          }),
        ),
      );

      const error = yield* Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(CheckpointThreadNotFoundError);
      expect(error).toMatchObject({
        operation: "CheckpointDiffQuery.getTurnDiff",
        threadId,
      });
      expect(error.message).toBe(
        "Checkpoint invariant violation in CheckpointDiffQuery.getTurnDiff: Thread 'thread-missing' not found.",
      );
    }),
  );
});
