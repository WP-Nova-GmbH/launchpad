import type {
  ThreadMoveProgressReport,
  ThreadMoveProgressSnapshot,
} from "@t3tools/contracts/relay";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/** Progress describes verified work, never authorizes it. Each retry starts a new attempt. */
export function makeThreadMoveProgress<E>(
  previous: ReadonlyArray<Pick<ThreadMoveProgressSnapshot, "environmentId" | "attempt">>,
  environmentId: string,
  send: (report: ThreadMoveProgressReport) => Effect.Effect<unknown, E>,
) {
  const attempt =
    Math.max(
      0,
      ...previous.filter((p) => p.environmentId === environmentId).map((p) => p.attempt),
    ) + 1;
  const lock = Semaphore.makeUnsafe(1);
  let revision = 0;
  let stage: ThreadMoveProgressReport["stage"] = "capturing";
  let totalBytes: number | null = null,
    totalArtifacts: number | null = null;
  let completedBytes = 0;
  const verified = new Set<string>();
  let lastSent = Number.NEGATIVE_INFINITY;
  const publish = Effect.fnUntraced(function* (force: boolean) {
    const time = yield* Clock.currentTimeMillis;
    if (!force && time - lastSent < 1000) return;
    revision += 1;
    yield* send({
      attempt,
      revision,
      stage,
      completedBytes,
      totalBytes,
      completedArtifacts: verified.size,
      totalArtifacts,
    }).pipe(Effect.timeout("1 second"), Effect.ignore);
    lastSent = yield* Clock.currentTimeMillis;
  });
  return {
    stage: (
      next: ThreadMoveProgressReport["stage"],
      totals?: { bytes: number; artifacts: number },
    ) =>
      lock.withPermit(
        Effect.gen(function* () {
          stage = next;
          completedBytes = 0;
          verified.clear();
          totalBytes = totals?.bytes ?? null;
          totalArtifacts = totals?.artifacts ?? null;
          yield* publish(true);
        }),
      ),
    verified: (artifactId: string, bytes: number) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (verified.has(artifactId)) return;
          verified.add(artifactId);
          completedBytes += bytes;
          yield* publish(totalArtifacts !== null && verified.size === totalArtifacts);
        }),
      ),
  };
}
