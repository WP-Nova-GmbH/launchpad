/**
 * CheckpointDiffQuery - Query interface for computed checkpoint diffs.
 *
 * Provides read-only diff operations across checkpoint snapshots used by
 * orchestration APIs.
 *
 * @module CheckpointDiffQuery
 */
import {
  CheckpointRef,
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { WorkflowVmDispatchBinding } from "@t3tools/contracts/workflows";
import type { WorkflowResultCapture } from "../jobs/WorkflowResultOutbox.ts";
import { parseGitPatchHeaderPaths, unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkflowCheckpointPin, WorkflowRunStore } from "../jobs/WorkflowRunStore.ts";
import { workflowReviewSecretMatcher, WorkflowVmAttempts } from "../relay/WorkflowVmAttempts.ts";
import { withWorkflowVmCancelledCheckpointRead } from "../relay/WorkflowVmCancellation.ts";
import { WorkflowVmGuest } from "../vmWorkloadCommand.ts";
import {
  CheckpointDiffResultInvalidError,
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
  CheckpointWorkflowDiffRestrictedError,
  CheckpointWorkflowPinUnavailableError,
  CheckpointWorkspacePathMissingError,
} from "./Errors.ts";
import type { CheckpointServiceError } from "./Errors.ts";
import { checkpointRefForThreadTurn } from "./Utils.ts";
import * as CheckpointStore from "./CheckpointStore.ts";

/** Service tag for checkpoint diff queries. */
export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  {
    /**
     * Read the patch diff for a single turn checkpoint transition.
     *
     * Verifies checkpoint availability in both projection state and filesystem.
     */
    readonly getTurnDiff: (
      input: OrchestrationGetTurnDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnDiffResultType, CheckpointServiceError>;

    /**
     * Read the full patch diff across a thread range of checkpoints.
     *
     * Uses turn-diff semantics with `fromTurnCount = 0`.
     */
    readonly getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;
    /** Internal archival read of an existing failed/cancelled capture; never Review evidence. */
    readonly getSavedWorkflowCaptureDiff: (
      binding: WorkflowVmDispatchBinding,
      capture: WorkflowResultCapture,
    ) => Effect.Effect<string, CheckpointServiceError>;
  }
>()("t3/checkpointing/CheckpointDiffQuery") {}

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);
const sameVmBinding = Schema.toEquivalence(WorkflowVmDispatchBinding);
const samePin = Schema.toEquivalence(WorkflowCheckpointPin);
function patchContainsWorkflowSecret(values: ReadonlyArray<string>, patch: string): boolean {
  if (values.length === 0) return false;
  const containsSecret = workflowReviewSecretMatcher(values);
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      if (parseGitPatchHeaderPaths(line.slice(11)).some((name) => name && containsSecret(name)))
        return true;
    } else if (line.startsWith("@@ ")) {
      inHunk = true;
      // Git may include source text after the hunk coordinates.
      const context = /^@@ .*? @@ (.*)$/su.exec(line)?.[1];
      if (context && containsSecret(context)) return true;
    } else if (inHunk) {
      if (/^[ +-]/u.test(line) && containsSecret(line.slice(1))) return true;
    } else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const token = line.slice(4).split("\t", 1)[0]!;
      if (token !== "/dev/null" && containsSecret(unquoteGitPatchPath(token).slice(2))) return true;
    } else {
      const name = /^(?:rename|copy) (?:from|to) (.*)$/su.exec(line)?.[1];
      if (name && containsSecret(unquoteGitPatchPath(name))) return true;
    }
  }
  return false;
}

function buildTurnDiffResult(
  input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  },
  diff: string,
): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    diff,
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const workflowRuns = yield* WorkflowRunStore;
  const workflowAttempts = yield* WorkflowVmAttempts;
  const workflowGuest = yield* WorkflowVmGuest;
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);

  const readDiff = Effect.fnUntraced(function* (
    binding: WorkflowVmDispatchBinding | null,
    threadId: ThreadId,
    turnCount: number,
    input: CheckpointStore.DiffCheckpointsInput,
  ) {
    const read = checkpointStore.diffCheckpoints(input);
    if (!workflowGuest || !binding) return yield* read;
    if (Option.isNone(sql))
      return yield* new CheckpointWorkflowPinUnavailableError({ threadId, turnCount });
    return yield* withWorkflowVmCancelledCheckpointRead(sql.value, binding, read).pipe(
      Effect.catchTag(["ThreadExecutionFenceError", "VmWorkloadError", "SqlError"], () =>
        Effect.fail(new CheckpointWorkflowPinUnavailableError({ threadId, turnCount })),
      ),
    );
  });

  const readWorkflowPin = Effect.fnUntraced(function* (
    binding: WorkflowVmDispatchBinding,
    context: ProjectionSnapshotQuery.ProjectionThreadCheckpointContext,
    turnCount: number,
  ) {
    const threadId = binding.threadId;
    if (turnCount === 0) {
      const pin = yield* workflowRuns.getCheckpointPinForRun(
        binding,
        "",
        checkpointRefForThreadTurn(threadId, 0),
      );
      if (pin) return CheckpointRef.make(pin.commitId);
    } else {
      const checkpoint = context.checkpoints.find(
        (entry) => entry.checkpointTurnCount === turnCount && entry.status === "ready",
      );
      if (checkpoint) {
        const pin = yield* workflowRuns.getCheckpointPinForTurn(
          threadId,
          checkpoint.turnId,
          turnCount,
        );
        if (pin?.checkpointRef === checkpoint.checkpointRef)
          return CheckpointRef.make(pin.commitId);
      }
    }
    return yield* new CheckpointWorkflowPinUnavailableError({ threadId, turnCount });
  });

  const verifySharedPatch = Effect.fnUntraced(function* (
    binding: WorkflowVmDispatchBinding | null,
    patch: string,
  ) {
    if (!binding || patch === "") return;
    const secrets = yield* workflowAttempts
      .readReviewSecrets(binding)
      .pipe(
        Effect.mapError(
          () => new CheckpointWorkflowDiffRestrictedError({ reason: "verification_unavailable" }),
        ),
      );
    if (patchContainsWorkflowSecret(Redacted.value(secrets), patch))
      return yield* new CheckpointWorkflowDiffRestrictedError({ reason: "contains_secret" });
  });

  const getSavedWorkflowCaptureDiff = Effect.fn("getSavedWorkflowCaptureDiff")(function* (
    binding: WorkflowVmDispatchBinding,
    capture: WorkflowResultCapture,
  ) {
    const threadId = binding.threadId;
    const unavailable = () =>
      new CheckpointWorkflowPinUnavailableError({ threadId, turnCount: capture.turnCount });
    const current = yield* workflowRuns.getVmBindingForThread(threadId);
    const pin = yield* workflowRuns.getCapturedWorkflowTurn(binding, capture.turnId);
    if (
      capture.outcome === "completed" ||
      !current ||
      !sameVmBinding(binding, current) ||
      !(yield* workflowRuns.isVmFenceActive(binding)) ||
      !pin ||
      pin.turnCount !== capture.turnCount ||
      !samePin(pin, capture)
    )
      return yield* unavailable();
    const context = yield* projectionSnapshotQuery.getThreadCheckpointContext(threadId);
    if (Option.isNone(context)) return yield* unavailable();
    const cwd = context.value.worktreePath ?? context.value.workspaceRoot;
    if (!cwd) return yield* unavailable();
    const diff = yield* readDiff(binding, threadId, capture.turnCount, {
      cwd,
      fromCheckpointRef: CheckpointRef.make(pin.baselineCommitId),
      toCheckpointRef: CheckpointRef.make(pin.commitId),
      pinned: true,
      requireComplete: true,
      ignoreWhitespace: false,
      fallbackFromToHead: false,
    });
    yield* verifySharedPatch(binding, diff);
    return diff;
  });

  const getTurnDiff: CheckpointDiffQuery["Service"]["getTurnDiff"] = Effect.fn("getTurnDiff")(
    function* (input) {
      const operation = "CheckpointDiffQuery.getTurnDiff";
      const strictWorkflowReview = input.strictWorkflowReview === true;
      const ignoreWhitespace = !strictWorkflowReview && (input.ignoreWhitespace ?? true);
      yield* Effect.annotateCurrentSpan({
        "checkpoint.thread_id": input.threadId,
        "checkpoint.from_turn_count": input.fromTurnCount,
        "checkpoint.to_turn_count": input.toTurnCount,
        "checkpoint.ignore_whitespace": ignoreWhitespace,
      });

      if (!strictWorkflowReview && input.fromTurnCount === input.toTurnCount) {
        const emptyDiff: OrchestrationGetTurnDiffResultType = {
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          diff: "",
        };
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointDiffResultInvalidError({
            operation,
            threadId: input.threadId,
          });
        }
        return emptyDiff;
      }

      const threadContext = yield* projectionSnapshotQuery
        .getThreadCheckpointContext(input.threadId)
        .pipe(Effect.withSpan("checkpoint.turnDiff.lookupContext"));
      if (Option.isNone(threadContext)) {
        return yield* new CheckpointThreadNotFoundError({
          operation,
          threadId: input.threadId,
        });
      }

      const maxTurnCount = threadContext.value.checkpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        return yield* new CheckpointTurnRangeUnavailableError({
          operation,
          threadId: input.threadId,
          requestedTurnCount: input.toTurnCount,
          availableTurnCount: maxTurnCount,
        });
      }

      const workspaceCwd = threadContext.value.worktreePath ?? threadContext.value.workspaceRoot;
      if (!workspaceCwd) {
        return yield* new CheckpointWorkspacePathMissingError({
          operation,
          threadId: input.threadId,
        });
      }

      let fromCheckpointRef: CheckpointRef;
      let toCheckpointRef: CheckpointRef;
      let targetTurnId: TurnId | undefined;
      const binding = yield* workflowRuns.getVmBindingForThread(input.threadId);
      if (strictWorkflowReview) {
        const unavailable = () =>
          new CheckpointWorkflowPinUnavailableError({
            threadId: input.threadId,
            turnCount: input.toTurnCount,
          });
        const checkpoint = threadContext.value.checkpoints.find(
          (checkpoint) =>
            checkpoint.checkpointTurnCount === input.toTurnCount &&
            checkpoint.turnId === input.expectedTurnId &&
            checkpoint.status === "ready",
        );
        if (!checkpoint || input.fromTurnCount !== input.toTurnCount - 1)
          return yield* unavailable();
        const pin = yield* workflowRuns.getCheckpointPinForTurn(
          input.threadId,
          checkpoint.turnId,
          input.toTurnCount,
        );
        if (!pin?.baselineCommitId || pin.checkpointRef !== checkpoint.checkpointRef)
          return yield* unavailable();
        fromCheckpointRef = CheckpointRef.make(pin.baselineCommitId);
        toCheckpointRef = CheckpointRef.make(pin.commitId);
        targetTurnId = checkpoint.turnId;
      } else if (binding) {
        fromCheckpointRef = yield* readWorkflowPin(
          binding,
          threadContext.value,
          input.fromTurnCount,
        );
        toCheckpointRef = yield* readWorkflowPin(binding, threadContext.value, input.toTurnCount);
      } else {
        const from =
          input.fromTurnCount === 0
            ? checkpointRefForThreadTurn(input.threadId, 0)
            : threadContext.value.checkpoints.find(
                (checkpoint) => checkpoint.checkpointTurnCount === input.fromTurnCount,
              )?.checkpointRef;
        if (!from) {
          return yield* new CheckpointRefUnavailableError({
            operation,
            threadId: input.threadId,
            turnCount: input.fromTurnCount,
            checkpoint: "from",
          });
        }

        const to = threadContext.value.checkpoints.find(
          (checkpoint) => checkpoint.checkpointTurnCount === input.toTurnCount,
        )?.checkpointRef;
        if (!to) {
          return yield* new CheckpointRefUnavailableError({
            operation,
            threadId: input.threadId,
            turnCount: input.toTurnCount,
            checkpoint: "to",
          });
        }
        fromCheckpointRef = from;
        toCheckpointRef = to;
      }

      const diff = yield* readDiff(binding, input.threadId, input.toTurnCount, {
        cwd: workspaceCwd,
        fromCheckpointRef,
        toCheckpointRef,
        fallbackFromToHead: false,
        ignoreWhitespace,
        ...(strictWorkflowReview ? { requireComplete: true } : {}),
        ...(binding ? { pinned: true } : {}),
      }).pipe(Effect.withSpan("checkpoint.turnDiff.diffCheckpoints"));
      yield* verifySharedPatch(binding, diff);

      const turnDiff = {
        ...buildTurnDiffResult(input, diff),
        ...(targetTurnId ? { completeWorkflowReview: true as const, targetTurnId } : {}),
      };
      if (!isTurnDiffResult(turnDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }

      return turnDiff;
    },
  );

  const getFullThreadDiff: CheckpointDiffQuery["Service"]["getFullThreadDiff"] = Effect.fn(
    "CheckpointDiffQuery.getFullThreadDiff",
  )(function* (input) {
    const operation = "CheckpointDiffQuery.getFullThreadDiff";
    const ignoreWhitespace = input.ignoreWhitespace ?? true;
    yield* Effect.annotateCurrentSpan({
      "checkpoint.thread_id": input.threadId,
      "checkpoint.from_turn_count": 0,
      "checkpoint.to_turn_count": input.toTurnCount,
      "checkpoint.ignore_whitespace": ignoreWhitespace,
      "checkpoint.diff_kind": "full-thread",
    });

    if (input.toTurnCount === 0) {
      const emptyDiff = buildTurnDiffResult(
        {
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: 0,
        },
        "",
      );
      if (!isTurnDiffResult(emptyDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }
      return emptyDiff satisfies OrchestrationGetFullThreadDiffResult;
    }

    const threadContext = yield* projectionSnapshotQuery
      .getFullThreadDiffContext(input.threadId, input.toTurnCount)
      .pipe(Effect.withSpan("checkpoint.fullThread.lookupContext"));

    if (Option.isNone(threadContext)) {
      return yield* new CheckpointThreadNotFoundError({
        operation,
        threadId: input.threadId,
      });
    }

    if (input.toTurnCount > threadContext.value.latestCheckpointTurnCount) {
      return yield* new CheckpointTurnRangeUnavailableError({
        operation,
        threadId: input.threadId,
        requestedTurnCount: input.toTurnCount,
        availableTurnCount: threadContext.value.latestCheckpointTurnCount,
      });
    }

    const workspaceCwd = threadContext.value.worktreePath ?? threadContext.value.workspaceRoot;
    if (!workspaceCwd) {
      return yield* new CheckpointWorkspacePathMissingError({
        operation,
        threadId: input.threadId,
      });
    }

    if (!threadContext.value.toCheckpointRef) {
      return yield* new CheckpointRefUnavailableError({
        operation,
        threadId: input.threadId,
        turnCount: input.toTurnCount,
        checkpoint: "to",
      });
    }

    const binding = yield* workflowRuns.getVmBindingForThread(input.threadId);
    let fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, 0);
    let toCheckpointRef = CheckpointRef.make(threadContext.value.toCheckpointRef);
    if (binding) {
      const context = yield* projectionSnapshotQuery.getThreadCheckpointContext(input.threadId);
      if (Option.isNone(context))
        return yield* new CheckpointThreadNotFoundError({ operation, threadId: input.threadId });
      fromCheckpointRef = yield* readWorkflowPin(binding, context.value, 0);
      toCheckpointRef = yield* readWorkflowPin(binding, context.value, input.toTurnCount);
    }
    const diff = yield* readDiff(binding, input.threadId, input.toTurnCount, {
      cwd: workspaceCwd,
      fromCheckpointRef,
      toCheckpointRef,
      fallbackFromToHead: false,
      ignoreWhitespace,
      ...(binding ? { pinned: true } : {}),
    }).pipe(Effect.withSpan("checkpoint.fullThread.diffCheckpoints"));
    yield* verifySharedPatch(binding, diff);

    const turnDiff = buildTurnDiffResult(
      {
        threadId: input.threadId,
        fromTurnCount: 0,
        toTurnCount: input.toTurnCount,
      },
      diff,
    );
    if (!isTurnDiffResult(turnDiff)) {
      return yield* new CheckpointDiffResultInvalidError({
        operation,
        threadId: input.threadId,
      });
    }

    return turnDiff satisfies OrchestrationGetFullThreadDiffResult;
  });

  return CheckpointDiffQuery.of({
    getTurnDiff,
    getFullThreadDiff,
    getSavedWorkflowCaptureDiff,
  });
});

export const layer = Layer.effect(CheckpointDiffQuery, make);
