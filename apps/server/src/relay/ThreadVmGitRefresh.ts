import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";
import { configureThreadVmRepository } from "./ThreadVmRepositoryBinding.ts";

/** Startup repair and metadata refresh run independently of the command inbox. */
export const refreshInstalledThreadVmRepository = Effect.gen(function* () {
  const vm = yield* readInstalledThreadVm();
  if (!vm) return null;
  const sql = yield* SqlClient.SqlClient;
  const owner = yield* makeThreadExecutionFence(sql).get(vm.scope.threadId);
  if (
    !owner ||
    owner.phase !== "active" ||
    owner.environmentId !== vm.environmentId ||
    owner.generation !== vm.scope.generation ||
    owner.relayUrl !== vm.relayUrl
  )
    return null;
  const [checkout] = yield* sql<{ root: string }>`SELECT
    COALESCE(t.worktree_path,p.workspace_root) AS root FROM projection_threads t
    JOIN projection_projects p USING(project_id) WHERE t.thread_id=${owner.threadId}
      AND t.project_id=${owner.projectId} AND t.deleted_at IS NULL AND p.deleted_at IS NULL`;
  if (!checkout) return null;
  return yield* configureThreadVmRepository(owner, checkout.root, "active");
});

/** Successful lookups expire too: an installed App can be removed or replaced later. */
export function makeThreadVmGitRefresh<E, R>(
  synchronize: Effect.Effect<{ readonly metadataPending: boolean } | null, E, R>,
) {
  const lock = Semaphore.makeUnsafe(1);
  let nextAttempt = 0,
    retryDelay = 30_000;
  return Effect.gen(function* () {
    const now = (yield* DateTime.now).epochMilliseconds;
    if (now < nextAttempt) return;
    const result = yield* synchronize.pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        () =>
          Effect.logDebug("VM Git setup or GitHub App metadata will retry").pipe(Effect.as(null)),
      ),
    );
    const completedAt = (yield* DateTime.now).epochMilliseconds;
    if (result && !result.metadataPending) {
      nextAttempt = completedAt + 300_000;
      retryDelay = 30_000;
    } else {
      nextAttempt = completedAt + retryDelay;
      retryDelay = Math.min(retryDelay * 2, 300_000);
    }
  }).pipe(lock.withPermit);
}
