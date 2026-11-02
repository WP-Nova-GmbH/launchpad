import type {
  ThreadMoveProgressReport,
  ThreadMoveProgressSnapshot,
  ThreadMoveWaitingForAuth,
} from "@t3tools/contracts/relay";
import type { ThreadMoveAttempt } from "../persistence/ThreadMoveAttempt.ts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/** Progress describes verified work, never authorizes it. Each retry starts a new attempt. */
export function makeThreadMoveProgress<E>(
  previous: ReadonlyArray<Pick<ThreadMoveProgressSnapshot, "environmentId" | "attempt">>,
  environmentId: string,
  send: (report: ThreadMoveProgressReport) => Effect.Effect<unknown, E>,
  journal?: ThreadMoveAttempt,
) {
  const attempt =
    journal?.attempt ??
    Math.max(
      0,
      ...previous.filter((p) => p.environmentId === environmentId).map((p) => p.attempt),
    ) + 1;
  const lock = Semaphore.makeUnsafe(1);
  let latest = journal?.report ?? null;
  let acknowledgedRevision = journal?.acknowledgedRevision ?? 0;
  let revision = latest?.revision ?? 0;
  let stage: ThreadMoveProgressReport["stage"] = latest?.stage ?? "capturing";
  let totalBytes = latest?.totalBytes ?? null,
    totalArtifacts = latest?.totalArtifacts ?? null;
  let completedBytes = latest?.completedBytes ?? 0;
  let completedArtifacts = latest?.completedArtifacts ?? 0;
  let waitingForAuth = latest?.waitingForAuth;
  const verified = new Set<string>();
  let lastSent = Number.NEGATIVE_INFINITY;
  const publish = Effect.fnUntraced(function* (force: boolean) {
    const time = yield* Clock.currentTimeMillis;
    if (!force && time - lastSent < 1000) return;
    const body = {
      stage,
      completedBytes,
      totalBytes,
      completedArtifacts,
      totalArtifacts,
      ...(waitingForAuth !== undefined ? { waitingForAuth } : {}),
    };
    const report = journal ? yield* journal.save(body) : { ...body, attempt, revision: ++revision };
    latest = report;
    const sent = yield* send(report).pipe(Effect.timeout("1 second"), Effect.result);
    if (sent._tag === "Success") {
      if (journal) yield* journal.acknowledge(report.revision);
      acknowledgedRevision = report.revision;
    }
    lastSent = yield* Clock.currentTimeMillis;
  });
  return {
    attempt,
    waitForAuth: (reason: ThreadMoveWaitingForAuth) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (!latest) stage = "downloading";
          if (latest?.waitingForAuth === reason && acknowledgedRevision >= latest.revision) return;
          waitingForAuth = reason;
          yield* publish(true);
        }),
      ),
    stage: (
      next: ThreadMoveProgressReport["stage"],
      totals?: { bytes: number; artifacts: number },
    ) =>
      lock.withPermit(
        Effect.gen(function* () {
          stage = next;
          completedBytes = 0;
          completedArtifacts = 0;
          verified.clear();
          if (journal) waitingForAuth = null;
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
          completedArtifacts += 1;
          completedBytes += bytes;
          yield* publish(totalArtifacts !== null && verified.size === totalArtifacts);
        }),
      ),
  };
}
