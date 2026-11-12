import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import type { ThreadMoveProgressReport } from "@t3tools/contracts/relay";
import { makeThreadMoveProgress } from "./ThreadMoveProgress.ts";

it.effect("coalesces chunk receipts, counts each artifact once, and flushes verified totals", () =>
  Effect.gen(function* () {
    const sent: ThreadMoveProgressReport[] = [];
    const progress = makeThreadMoveProgress([], "source", (report) =>
      Effect.sync(() => sent.push(report)),
    );
    yield* progress.stage("uploading", { bytes: 30000, artifacts: 30000 });
    for (let i = 0; i < 29999; i++) yield* progress.verified(String(i), 1);
    yield* progress.verified("0", 1);
    expect(sent).toHaveLength(1);
    yield* TestClock.adjust("1 second");
    yield* progress.verified("29999", 1);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      stage: "uploading",
      completedBytes: 30000,
      completedArtifacts: 30000,
      revision: 2,
    });
  }),
);

it.effect(
  "keeps an unknown total distinct from an empty archive and ignores reporting failures",
  () =>
    Effect.gen(function* () {
      const sent: ThreadMoveProgressReport[] = [];
      const progress = makeThreadMoveProgress([], "destination", (report) =>
        Effect.sync(() => sent.push(report)).pipe(Effect.andThen(Effect.fail("relay unavailable"))),
      );
      yield* progress.stage("installing");
      yield* progress.stage("setup", { bytes: 0, artifacts: 0 });
      expect(sent[0]?.totalBytes).toBeNull();
      expect(sent[1]?.totalBytes).toBe(0);
      expect(sent[1]?.revision).toBe(2);
    }),
);

it.effect(
  "starts a newer attempt for this participant without borrowing the other side's attempt",
  () =>
    Effect.gen(function* () {
      const previous = [
        { environmentId: "source", attempt: 3 },
        { environmentId: "destination", attempt: 7 },
      ];
      const reports: ThreadMoveProgressReport[] = [];
      // Only attempt and environment identify the resume boundary; full snapshots are covered at the relay schema.
      const progress = makeThreadMoveProgress(previous, "source", (report) =>
        Effect.sync(() => reports.push(report)),
      );
      yield* progress.stage("capturing");
      expect(reports[0]?.attempt).toBe(4);
    }),
);
