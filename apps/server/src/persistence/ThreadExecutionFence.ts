// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import type { OrchestrationCommand } from "@t3tools/contracts";
import { assertWorkflowThreadReleased } from "./WorkflowThreadOwnership.ts";
import { assertThreadTransferRuntime } from "./ThreadTransferRuntime.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export class ThreadExecutionFenceError extends Schema.TaggedError<ThreadExecutionFenceError>()(
  "ThreadExecutionFenceError",
  {
    threadId: Schema.String,
    detail: Schema.String,
    /** Checkout rejection binds exact output retries. Null means an unfenced local thread. */
    ownership: Schema.optionalKey(
      Schema.NullOr(Schema.Struct({ environmentId: Schema.String, generation: Schema.Number })),
    ),
  },
) {
  override get message() {
    return this.detail;
  }
}

interface Fence {
  readonly threadId: string;
  readonly relayUrl: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly generation: number;
  readonly operationId: string;
  readonly phase: "active" | "draining" | "frozen" | "retired";
  readonly frozenSequence: number | null;
}
type Identity = Pick<Fence, "threadId" | "generation">;
type Operation = Identity & Pick<Fence, "operationId">;
type Enrollment = Omit<Fence, "phase" | "frozenSequence">;
type Work = Identity & {
  readonly workId: string;
  readonly kind: "provider" | "terminal" | "setup" | "workspace";
};

/**
 * Local durable half of relay ownership. Callers verify relay acknowledgements before
 * activation/admission; elapsed time or a server restart can never release a fence.
 * Initial enrollment also needs a drain of previously untracked local processes.
 */
export function makeThreadExecutionFence(sql: SqlClient.SqlClient) {
  const fail = (threadId: string, detail: string) =>
    new ThreadExecutionFenceError({ threadId, detail });
  const get = Effect.fn("ThreadExecutionFence.get")(function* (threadId: string) {
    const [row] = yield* sql<Fence>`SELECT thread_id AS "threadId", relay_url AS "relayUrl",
      environment_id AS "environmentId", project_id AS "projectId", generation,
      operation_id AS "operationId", phase, frozen_sequence AS "frozenSequence"
      FROM thread_execution_fences WHERE thread_id = ${threadId}`;
    return row ?? null;
  });
  const assertDirectClientAllowed = Effect.fn("ThreadExecutionFence.assertDirectClientAllowed")(
    function* (threadId: string, commandType?: OrchestrationCommand["type"]) {
      if (yield* get(threadId))
        return yield* fail(threadId, "Send this thread's commands through the relay inbox.");
      // A local move creates its durable queue before relay enrollment. Until
      // then, direct turns must not bypass paused work or a waiting move.
      if (commandType === "thread.turn.start" || commandType === "thread.message.user.append") {
        const queued = yield* sql`SELECT 1 FROM projection_thread_prompt_queues
          WHERE thread_id=${threadId} LIMIT 1`;
        if (queued.length)
          return yield* fail(
            threadId,
            "This thread uses a shared queue. Submit prompts through the queue.",
          );
      }
    },
  );
  const current = Effect.fnUntraced(function* (input: Identity) {
    const row = yield* get(input.threadId);
    if (!row || row.generation !== input.generation)
      return yield* fail(input.threadId, "This environment does not own that thread generation.");
    return row;
  });
  const operation = Effect.fnUntraced(function* (input: Operation) {
    const row = yield* current(input);
    if (row.operationId !== input.operationId)
      return yield* fail(input.threadId, "The thread is held by a different operation.");
    return row;
  });
  const requireIdle = Effect.fnUntraced(function* (threadId: string) {
    const pending = yield* sql`SELECT 1 FROM thread_execution_work
      WHERE thread_id = ${threadId} AND completed = 0 LIMIT 1`;
    if (pending.length) return yield* fail(threadId, "Thread work has not been confirmed stopped.");
  });
  const prepare = Effect.fn("ThreadExecutionFence.prepare")(function* (input: Enrollment) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertWorkflowThreadReleased(sql, input.threadId).pipe(
          Effect.mapError((error) => fail(input.threadId, error.message)),
        );
        const prior = yield* get(input.threadId);
        if (prior) {
          if (prior.relayUrl !== input.relayUrl || prior.environmentId !== input.environmentId)
            return yield* fail(input.threadId, "Portable thread enrollment authority changed.");
          if (prior.generation === input.generation && prior.operationId === input.operationId) {
            if (prior.projectId !== input.projectId)
              return yield* fail(input.threadId, "Portable thread enrollment intent changed.");
            return prior;
          }
          const aborted =
            prior.phase === "retired" && prior.generation === input.generation
              ? yield* sql`
            SELECT 1 FROM thread_transfer_aborts WHERE operation_id=${prior.operationId} AND thread_id=${input.threadId}
              AND generation=${input.generation} AND environment_id=${input.environmentId}`
              : [];
          if (
            prior.phase !== "retired" ||
            input.generation < prior.generation ||
            (input.generation === prior.generation && !aborted.length)
          )
            return yield* fail(
              input.threadId,
              "The previous thread ownership has not been retired.",
            );
          yield* requireIdle(input.threadId);
          if (aborted.length) {
            yield* sql`DELETE FROM thread_transfer_baselines WHERE operation_id=${prior.operationId}`;
            yield* sql`DELETE FROM thread_transfer_readiness WHERE operation_id=${prior.operationId}`;
            yield* sql`DELETE FROM thread_checkout_claim_projects WHERE operation_id=${prior.operationId}`;
            yield* sql`DELETE FROM thread_checkout_claims WHERE operation_id=${prior.operationId} AND phase='released' AND release_reason='cancelled'`;
          }
          yield* sql`UPDATE thread_execution_fences SET project_id = ${input.projectId},
          generation = ${input.generation}, operation_id = ${input.operationId},
          phase = 'frozen', frozen_sequence = NULL WHERE thread_id = ${input.threadId}`;
        } else {
          yield* sql`INSERT INTO thread_execution_fences
          (thread_id, relay_url, environment_id, project_id, generation, operation_id, phase)
          VALUES (${input.threadId}, ${input.relayUrl}, ${input.environmentId}, ${input.projectId},
          ${input.generation}, ${input.operationId}, 'frozen')`;
        }
        return yield* get(input.threadId);
      }),
    );
  });
  // Activation is called only after the relay confirms this exact operation's owner.
  // For cancellation, that confirmation includes removal of the partial destination.
  const activate = Effect.fn("ThreadExecutionFence.activate")(function* (input: Operation) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertWorkflowThreadReleased(sql, input.threadId).pipe(
          Effect.mapError((error) => fail(input.threadId, error.message)),
        );
        const row = yield* operation(input);
        if (row.phase === "active") return;
        if (row.phase !== "frozen" && row.phase !== "draining")
          return yield* fail(input.threadId, "Retired ownership cannot be reactivated.");
        const [checkout] = yield* sql<{ phase: string; ready: number }>`SELECT c.phase,
          EXISTS(SELECT 1 FROM thread_transfer_baselines b JOIN projection_threads t ON t.thread_id = b.thread_id
            WHERE b.operation_id = c.operation_id AND b.generation = c.generation
              AND b.manifest_sha256 = c.manifest_sha256 AND t.project_id = c.project_id
              AND t.branch IS c.branch AND ((c.mode = 'main' AND t.worktree_path IS NULL)
                OR (c.mode = 'worktree' AND t.worktree_path = c.checkout_path))) AS ready
          FROM thread_checkout_claims c WHERE c.thread_id = ${input.threadId}
            AND c.generation = ${input.generation} AND c.phase <> 'released'`;
        if (checkout && (checkout.phase !== "installed" || !checkout.ready))
          return yield* fail(
            input.threadId,
            "Checkout and history installation must finish before activation.",
          );
        if (checkout) {
          const ready = yield* sql`SELECT 1 FROM thread_transfer_readiness r
            JOIN thread_transfer_baselines b USING(operation_id)
            WHERE r.operation_id = ${input.operationId} AND r.phase = 'ready'
              AND r.manifest_sha256 = b.manifest_sha256 AND r.native_runtime_json = b.native_runtime_json`;
          if (!ready.length)
            return yield* fail(
              input.threadId,
              "Destination setup and native continuation must be verified before activation.",
            );
          yield* assertThreadTransferRuntime(sql, input.operationId).pipe(
            Effect.mapError((error) => fail(input.threadId, error.message)),
          );
        }
        yield* sql`UPDATE thread_checkout_claims SET phase = 'released', release_reason = 'activated'
          WHERE operation_id = ${input.operationId} AND phase = 'installed'`;
        yield* sql`UPDATE thread_execution_fences SET phase = 'active', frozen_sequence = NULL
        WHERE thread_id = ${input.threadId}`;
      }),
    );
  });
  const beginDrain = Effect.fn("ThreadExecutionFence.beginDrain")(function* (
    input: Operation & { readonly previousOperationId: string },
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertWorkflowThreadReleased(sql, input.threadId).pipe(
          Effect.mapError((error) => fail(input.threadId, error.message)),
        );
        const row = yield* current(input);
        if (row.phase !== "active") {
          if (
            row.operationId === input.operationId &&
            (row.phase === "draining" || row.phase === "frozen")
          )
            return;
          return yield* fail(input.threadId, "Thread ownership is already held.");
        }
        if (row.operationId === input.operationId || row.operationId !== input.previousOperationId)
          return yield* fail(
            input.threadId,
            "The drain no longer matches the current ownership operation.",
          );
        yield* sql`UPDATE thread_execution_fences SET phase = 'draining', operation_id = ${input.operationId}
        WHERE thread_id = ${input.threadId}`;
      }),
    );
  });
  const freeze = Effect.fn("ThreadExecutionFence.freeze")(function* (input: Operation) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertWorkflowThreadReleased(sql, input.threadId).pipe(
          Effect.mapError((error) => fail(input.threadId, error.message)),
        );
        const row = yield* operation(input);
        if (row.phase === "frozen" && row.frozenSequence !== null) return row.frozenSequence;
        if (row.phase !== "draining")
          return yield* fail(input.threadId, "Drain the thread before freezing it.");
        yield* requireIdle(input.threadId);
        const [capture] = yield* sql<{ checkoutRoot: string; gitCommonRoot: string }>`
          SELECT checkout_root AS "checkoutRoot",git_common_root AS "gitCommonRoot" FROM checkout_capture_holds
          WHERE operation_id=${input.operationId} AND thread_id=${input.threadId}
            AND generation=${input.generation} AND phase!='released'`;
        const pending = capture
          ? (yield* sql<{
              path: string | null;
              kind: string;
            }>`SELECT p.path,o.kind FROM checkout_operations o
              LEFT JOIN checkout_operation_paths p USING(operation_id)`).some(
              ({ path, kind }) =>
                path === null ||
                overlaps(path, capture.checkoutRoot) ||
                (kind === "vcs" && overlaps(path, capture.gitCommonRoot)),
            )
          : (yield* sql`SELECT 1 FROM checkout_operation_projects
              WHERE project_id = ${row.projectId} LIMIT 1`).length > 0;
        if (pending)
          return yield* fail(
            input.threadId,
            "Checkout operations have not been confirmed stopped.",
          );
        const [head] = yield* sql<{
          sequence: number;
        }>`SELECT COALESCE(MAX(sequence), 0) AS sequence
        FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}`;
        const sequence = head!.sequence;
        yield* sql`UPDATE thread_execution_fences SET phase = 'frozen', frozen_sequence = ${sequence}
        WHERE thread_id = ${input.threadId}`;
        return sequence;
      }),
    );
  });
  const retire = Effect.fn("ThreadExecutionFence.retire")(function* (input: Operation) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* operation(input);
        if (row.phase === "retired") return;
        if (row.phase !== "frozen")
          return yield* fail(input.threadId, "Freeze the thread before retiring ownership.");
        yield* requireIdle(input.threadId);
        const reports = yield* sql`SELECT 1 FROM thread_execution_work
          WHERE thread_id = ${input.threadId} AND relay_completed = 0 LIMIT 1`;
        if (reports.length)
          return yield* fail(
            input.threadId,
            "Execution completion still needs relay acknowledgement.",
          );
        yield* sql`UPDATE thread_execution_fences SET phase = 'retired' WHERE thread_id = ${input.threadId}`;
      }),
    );
  });
  // true grants the first local start. false means reconcile the existing work;
  // a lost reply or restart must not execute a possibly completed tool again.
  const beginWork = Effect.fn("ThreadExecutionFence.beginWork")(function* (input: Work) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* current(input);
        const [existing] = yield* sql<{ generation: number; kind: string }>`SELECT generation, kind
        FROM thread_execution_work WHERE thread_id = ${input.threadId} AND work_id = ${input.workId}`;
        if (existing) {
          if (existing.generation !== input.generation || existing.kind !== input.kind)
            return yield* fail(
              input.threadId,
              "Execution identity was already used for different work.",
            );
          return false;
        }
        if (row.phase !== "active")
          return yield* fail(input.threadId, "The thread is not accepting new work here.");
        yield* sql`INSERT INTO thread_execution_work (thread_id, work_id, generation, kind)
        VALUES (${input.threadId}, ${input.workId}, ${input.generation}, ${input.kind})`;
        return true;
      }),
    );
  });
  const getWork = Effect.fn("ThreadExecutionFence.getWork")(function* (input: Work) {
    const [row] = yield* sql<{
      generation: number;
      kind: string;
      started: number;
      completed: number;
      relayCompleted: number;
    }>`SELECT generation, kind, started, completed, relay_completed AS "relayCompleted"
      FROM thread_execution_work WHERE thread_id = ${input.threadId} AND work_id = ${input.workId}`;
    if (row && (row.generation !== input.generation || row.kind !== input.kind))
      return yield* fail(input.threadId, "Execution identity was already used for different work.");
    return row ?? null;
  });
  const reserveWork = Effect.fn("ThreadExecutionFence.reserveWork")(function* (input: Work) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* current(input);
        const prior = yield* getWork(input);
        if (prior) return prior;
        if (row.phase !== "active")
          return yield* fail(input.threadId, "The thread is not accepting new work here.");
        yield* sql`INSERT INTO thread_execution_work (thread_id, work_id, generation, kind, started)
        VALUES (${input.threadId}, ${input.workId}, ${input.generation}, ${input.kind}, 0)`;
        return { ...input, started: 0, completed: 0, relayCompleted: 0 };
      }),
    );
  });
  const startReservedWork = Effect.fn("ThreadExecutionFence.startReservedWork")(function* (
    input: Work,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* current(input);
        const prior = yield* getWork(input);
        if (!prior) return yield* fail(input.threadId, "Work was not reserved before admission.");
        if (prior.completed) return "completed" as const;
        if (prior.started) return "reconcile" as const;
        if (row.phase !== "active") return "held" as const;
        yield* sql`UPDATE thread_execution_work SET started = 1
        WHERE thread_id = ${input.threadId} AND work_id = ${input.workId}`;
        return "start" as const;
      }),
    );
  });
  const acknowledgeWork = Effect.fn("ThreadExecutionFence.acknowledgeWork")(function* (
    input: Work,
  ) {
    const rows = yield* sql`UPDATE thread_execution_work SET relay_completed = 1
      WHERE thread_id = ${input.threadId} AND work_id = ${input.workId} AND generation = ${input.generation}
      AND kind = ${input.kind} AND completed = 1 RETURNING work_id`;
    if (!rows.length) return yield* fail(input.threadId, "Cannot acknowledge unconfirmed work.");
  });
  const pendingCompletionReports = Effect.fn("ThreadExecutionFence.pendingCompletionReports")(
    function* () {
      return yield* sql<
        Array<Work>[number]
      >`SELECT thread_id AS "threadId", work_id AS "workId", generation, kind
      FROM thread_execution_work WHERE completed = 1 AND relay_completed = 0`;
    },
  );
  const completeWork = Effect.fn("ThreadExecutionFence.completeWork")(function* (input: Work) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* current(input);
        const rows = yield* sql`UPDATE thread_execution_work SET completed = 1
        WHERE thread_id = ${input.threadId} AND work_id = ${input.workId}
        AND generation = ${input.generation} AND kind = ${input.kind} RETURNING work_id`;
        if (!rows.length) return yield* fail(input.threadId, "Cannot confirm unknown thread work.");
      }),
    );
  });
  const overlaps = (left: string, right: string) => {
    const within = (root: string, candidate: string) =>
      candidate === root ||
      candidate.startsWith(root.endsWith(NodePath.sep) ? root : `${root}${NodePath.sep}`);
    return within(left, right) || within(right, left);
  };
  // Operation paths and claims are canonical when admitted. A new project must
  // supply its canonical root; missing path evidence still blocks registration.
  const pendingCheckoutOperation = Effect.fnUntraced(function* (workspaceRoot?: string) {
    if (workspaceRoot === undefined) {
      return (yield* sql`SELECT 1 FROM checkout_operations LIMIT 1`).length > 0;
    }
    const pending = yield* sql<{ path: string | null }>`SELECT p.path FROM checkout_operations o
      LEFT JOIN checkout_operation_paths p USING(operation_id)`;
    return pending.some(({ path }) => path === null || overlaps(path, workspaceRoot));
  });
  const reservedCheckout = Effect.fnUntraced(function* (workspaceRoot?: string) {
    const claims = yield* sql<{ threadId: string; repositoryRoot: string; checkoutPath: string }>`
      SELECT thread_id AS "threadId", repository_root AS "repositoryRoot", checkout_path AS "checkoutPath"
      FROM thread_checkout_claims WHERE phase <> 'released'`;
    return claims.find(
      (claim) =>
        workspaceRoot === undefined ||
        overlaps(claim.repositoryRoot, workspaceRoot) ||
        overlaps(claim.checkoutPath, workspaceRoot),
    );
  });
  const assertProjectPathMutable = Effect.fn("ThreadExecutionFence.assertProjectPathMutable")(
    function* (workspaceRoot?: string) {
      if (yield* pendingCheckoutOperation(workspaceRoot))
        return yield* fail("", "Finish checkout operations before changing project paths.");
      const claim = yield* reservedCheckout(workspaceRoot);
      if (claim)
        return yield* fail(
          claim.threadId,
          "Finish the checkout installation before changing project paths.",
        );
    },
  );
  const assertCheckoutAvailable = Effect.fn("ThreadExecutionFence.assertCheckoutAvailable")(
    function* (input: { readonly threadId?: string; readonly projectId?: string }) {
      const [claim] = yield* sql<{ threadId: string }>`SELECT c.thread_id AS "threadId"
      FROM thread_checkout_claims c JOIN thread_checkout_claim_projects p USING (operation_id)
      WHERE c.phase <> 'released' AND (p.project_id = ${input.projectId ?? null} OR
        EXISTS (SELECT 1 FROM projection_threads t WHERE t.thread_id = ${input.threadId ?? null}
          AND t.project_id = p.project_id AND (t.worktree_path = c.checkout_path OR
            (t.worktree_path IS NULL AND c.mode = 'main')))) LIMIT 1`;
      if (claim)
        return yield* fail(
          claim.threadId,
          "A thread move has reserved this project's checkout. Wait for installation or cancel the move.",
        );
    },
  );
  // Use inside the same transaction as the mutation. Draining permits completion
  // events; individual execution producers must also pass beginWork.
  const assertMutable = Effect.fn("ThreadExecutionFence.assertMutable")(function* (
    threadId: string,
    expectedOwnership?: { readonly environmentId: string; readonly generation: number } | null,
  ) {
    const row = yield* get(threadId);
    if (
      expectedOwnership !== undefined &&
      (expectedOwnership === null
        ? row !== null
        : row?.environmentId !== expectedOwnership.environmentId ||
          row.generation !== expectedOwnership.generation)
    )
      return yield* fail(threadId, "Provider output belongs to a previous thread ownership.");
    if (row && row.phase !== "active" && row.phase !== "draining")
      return yield* fail(
        threadId,
        "This thread is frozen or has moved. Waiting for its current environment.",
      );
    const ownership = row ? { environmentId: row.environmentId, generation: row.generation } : null;
    yield* assertCheckoutAvailable({ threadId }).pipe(
      Effect.catchTag("ThreadExecutionFenceError", (error) =>
        Effect.fail(
          new ThreadExecutionFenceError({
            threadId: error.threadId,
            detail: error.detail,
            ownership,
          }),
        ),
      ),
    );
  });
  const assertProjectMutable = Effect.fn("ThreadExecutionFence.assertProjectMutable")(function* (
    projectId: string,
    workspaceRoot?: string,
  ) {
    yield* assertCheckoutAvailable({ projectId });
    const pending = yield* sql`SELECT 1 FROM checkout_operations o WHERE
      EXISTS (SELECT 1 FROM checkout_operation_projects p WHERE p.operation_id = o.operation_id AND p.project_id = ${projectId})
      OR (${workspaceRoot ?? null} IS NULL AND NOT EXISTS (SELECT 1 FROM projection_projects WHERE project_id = ${projectId})) LIMIT 1`;
    if (
      pending.length ||
      (workspaceRoot !== undefined && (yield* pendingCheckoutOperation(workspaceRoot)))
    )
      return yield* fail("", "Finish checkout operations before changing project registrations.");
    const [known] = yield* sql`SELECT 1 FROM projection_projects WHERE project_id = ${projectId}`;
    const unresolved =
      !known || workspaceRoot !== undefined ? yield* reservedCheckout(workspaceRoot) : undefined;
    if (unresolved)
      return yield* fail(
        unresolved.threadId,
        "Finish the checkout installation before adding another project.",
      );
    const [held] = yield* sql<{ threadId: string }>`SELECT f.thread_id AS "threadId"
      FROM thread_execution_fences f WHERE f.project_id = ${projectId} AND f.phase IN ('frozen', 'retired')
        AND NOT EXISTS (SELECT 1 FROM checkout_capture_holds h
          WHERE h.operation_id=f.operation_id AND h.thread_id=f.thread_id
            AND h.generation=f.generation AND h.phase='released') LIMIT 1`;
    if (held) return yield* fail(held.threadId, "This project contains a frozen or moved thread.");
  });
  return {
    get,
    assertDirectClientAllowed,
    prepare,
    activate,
    beginDrain,
    freeze,
    retire,
    beginWork,
    getWork,
    reserveWork,
    startReservedWork,
    completeWork,
    acknowledgeWork,
    pendingCompletionReports,
    assertProjectPathMutable,
    assertCheckoutAvailable,
    assertMutable,
    assertProjectMutable,
  };
}
